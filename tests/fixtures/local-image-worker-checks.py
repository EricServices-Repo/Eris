"""Check the real worker's loading/downloading contract without installing model weights."""
import base64
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("worker", Path(__file__).parents[2] / "resources/image-generation/worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZLsAAAAASUVORK5CYII=")
INDEX = {"_class_name": "StableDiffusionPipeline", "image_encoder": [None, None], "feature_extractor": [None, None], "safety_checker": [None, None],
         "unet": ["diffusers", "UNet2DConditionModel"], "vae": ["diffusers", "AutoencoderKL"], "text_encoder": ["transformers", "CLIPTextModel"], "tokenizer": ["transformers", "CLIPTokenizer"], "scheduler": ["diffusers", "EulerDiscreteScheduler"]}


class WorkerChecks(unittest.TestCase):
    def test_standard_pipeline_and_null_components_and_custom_code_rejection(self):
        self.assertEqual(worker.validate_index(INDEX), "StableDiffusionPipeline")
        for change in [{"_class_name": "CustomPipeline"}, {"unet": ["evil_code", "Model"]}, {"unet": [None, None]}]:
            with self.assertRaises(ValueError):
                worker.validate_index({**INDEX, **change})

    def test_download_selection_uses_fp16_and_never_pickle_or_python(self):
        names = ["model_index.json", "unet/config.json", "unet/diffusion_pytorch_model.safetensors", "unet/diffusion_pytorch_model.fp16.safetensors", "vae/diffusion_pytorch_model.fp16.safetensors", "tokenizer/vocab.json", "text_encoder/pytorch_model.bin", "custom.py", "sd_turbo.safetensors"]
        files, variant = worker.selected_files([types.SimpleNamespace(rfilename=name) for name in names])
        self.assertEqual(variant, "fp16")
        self.assertIn("unet/diffusion_pytorch_model.fp16.safetensors", files)
        self.assertNotIn("unet/diffusion_pytorch_model.safetensors", files)
        self.assertFalse(any(name.endswith((".bin", ".py")) for name in files))
        with self.assertRaises(ValueError):
            worker.selected_files([types.SimpleNamespace(rfilename="../escape.safetensors")])

    def test_download_pins_revision_and_verifies_every_weight(self):
        with tempfile.TemporaryDirectory() as directory:
            contents = {"model_index.json": json.dumps(INDEX).encode()}
            contents.update({name + "/model.fp16.safetensors": b"safe-weights" for name in ["unet", "vae", "text_encoder"]})
            siblings = [types.SimpleNamespace(rfilename=name, size=len(value), lfs=types.SimpleNamespace(sha256=hashlib.sha256(value).hexdigest())) for name, value in contents.items()]
            calls = []
            def hub_file(repo, filename, **kwargs):
                self.assertEqual(kwargs["revision"], "a" * 40)
                self.assertFalse(kwargs["token"])
                target = Path(directory) / filename
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(contents[filename])
                return str(target)
            def snapshot(repo, **kwargs):
                calls.append(kwargs)
                for filename in kwargs["allow_patterns"]:
                    hub_file(repo, filename, revision=kwargs["revision"], token=False)
            class Api:
                def model_info(self, *_args, **_kwargs):
                    return types.SimpleNamespace(sha="a" * 40, siblings=siblings)
            fake_hub = types.SimpleNamespace(HfApi=Api, hf_hub_download=hub_file, snapshot_download=snapshot)
            with patch.dict(sys.modules, {"huggingface_hub": fake_hub, "tqdm.auto": types.SimpleNamespace(tqdm=object)}):
                result = worker.download({"repoId": "stabilityai/sd-turbo", "modelPath": directory})
                self.assertEqual(result["revision"], "a" * 40)
                self.assertEqual(len(result["files"]), 4)
                self.assertEqual(calls[0]["max_workers"], 2)
                siblings[-1].lfs.sha256 = "0" * 64
                with self.assertRaisesRegex(ValueError, "checksum"):
                    worker.download({"repoId": "stabilityai/sd-turbo", "modelPath": directory})

    def test_generation_is_offline_and_uses_native_turbo_dimensions(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "model_index.json").write_text(json.dumps(INDEX))
            recorded = {}
            class Image:
                def save(self, path, format):
                    self_format = format
                    if self_format != "PNG": raise AssertionError("Wrong output format")
                    Path(path).write_bytes(PNG)
            class Pipeline:
                @classmethod
                def from_pretrained(cls, path, **kwargs):
                    recorded["load"] = kwargs
                    recorded["path"] = path
                    return cls()
                def set_progress_bar_config(self, **kwargs): pass
                def enable_attention_slicing(self): pass
                def enable_vae_slicing(self): pass
                def to(self, device): recorded["device"] = device
                def __call__(self, **kwargs):
                    recorded["inference"] = kwargs
                    return types.SimpleNamespace(images=[Image()])
            fake_torch = types.SimpleNamespace(float32="fp32", float16="fp16", cuda=types.SimpleNamespace(is_available=lambda: False), backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False)), inference_mode=contextlib.nullcontext, set_num_threads=lambda count: None)
            with patch.dict(sys.modules, {"torch": fake_torch, "diffusers": types.SimpleNamespace(StableDiffusionPipeline=Pipeline, StableDiffusionXLPipeline=Pipeline)}), patch.dict(os.environ, {}, clear=False):
                output = str(Path(directory) / "out.png")
                worker.generate({"repoId": "stabilityai/sd-turbo", "modelPath": directory, "variant": "fp16", "prompt": "A mountain", "size": "1536x1024", "outputPath": output})
                self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
                self.assertTrue(recorded["load"]["local_files_only"])
                self.assertTrue(recorded["load"]["use_safetensors"])
                self.assertEqual(recorded["load"]["variant"], "fp16")
                self.assertEqual(recorded["device"], "cpu")
                self.assertEqual(recorded["inference"]["width"], 512)
                self.assertEqual(recorded["inference"]["height"], 336)
                self.assertEqual(recorded["inference"]["num_inference_steps"], 2)
                self.assertEqual(recorded["inference"]["guidance_scale"], 0.0)
                self.assertEqual(Path(output).read_bytes(), PNG)


if __name__ == "__main__":
    unittest.main()
