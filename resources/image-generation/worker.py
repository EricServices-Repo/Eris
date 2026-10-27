"""Isolated Diffusers worker. One JSON request on stdin; JSONL progress/result on stdout."""
import contextlib
import gc
import hashlib
import json
import os
import shutil
from pathlib import Path
import sys
import time

SUPPORTED = {"StableDiffusionPipeline", "StableDiffusionXLPipeline"}
COMPONENTS = {"unet", "vae", "text_encoder", "text_encoder_2", "tokenizer", "tokenizer_2", "scheduler", "feature_extractor", "safety_checker"}
PROTOCOL_STDOUT = sys.stdout


def emit(event):
    print(json.dumps(event), file=PROTOCOL_STDOUT, flush=True)


def progress(message):
    emit({"type": "progress", "message": message})


def validate_index(index):
    if index.get("_class_name") not in SUPPORTED:
        raise ValueError("This model is unsupported. Use a Stable Diffusion or SDXL Diffusers pipeline.")
    for key, value in index.items():
        if key.startswith("_") or not isinstance(value, list):
            continue
        if value == [None, None]:
            continue
        if key not in COMPONENTS or len(value) != 2:
            raise ValueError("Unsupported model component: " + key)
        library, name = value
        if library is not None and library not in {"diffusers", "transformers", "stable_diffusion"}:
            raise ValueError("Custom model code is unsupported")
        if name is not None and (not isinstance(name, str) or not name.isidentifier() or name.startswith("_")):
            raise ValueError("Invalid component class")
    for key in ["unet", "vae", "text_encoder", "tokenizer", "scheduler"]:
        if not isinstance(index.get(key), list) or len(index[key]) != 2 or any(value is None for value in index[key]):
            raise ValueError("Model is missing a required component: " + key)
    return index["_class_name"]


def selected_files(siblings):
    """Download configuration/tokenizers plus one safe weight variant per component."""
    names = [entry.rfilename for entry in siblings]
    for name in names:
        path = Path(name)
        if path.is_absolute() or ".." in path.parts or "\\" in name:
            raise ValueError("Unsafe Hugging Face file path")
    selected = [name for name in names if name == "model_index.json"]
    variant = None
    for component in COMPONENTS:
        candidates = [name for name in names if name.startswith(component + "/")]
        selected += [name for name in candidates if Path(name).suffix in {".json", ".txt", ".model"}]
        weights = [name for name in candidates if name.endswith(".safetensors")]
        fp16 = [name for name in weights if ".fp16." in name or ".fp16-" in name]
        if fp16:
            selected += fp16
            variant = "fp16"
        else:
            selected += [name for name in weights if not any(tag in name for tag in [".bf16", ".fp32", ".non_ema"])]
    if "model_index.json" not in selected or not any(name.endswith(".safetensors") for name in selected):
        raise ValueError("Repository must contain a Diffusers model_index.json and safetensors weights")
    return sorted(set(selected)), variant


def download(request):
    from huggingface_hub import HfApi, hf_hub_download, snapshot_download
    from tqdm.auto import tqdm
    repo = request["repoId"]
    token = request.get("token") or False
    directory = Path(request["modelPath"])
    directory.mkdir(parents=True, exist_ok=True)
    progress("Reading Hugging Face model metadata…")
    info = HfApi().model_info(repo, files_metadata=True, token=token)
    revision = info.sha
    index_path = hf_hub_download(repo, "model_index.json", revision=revision, token=token, local_dir=str(directory))
    with open(index_path, encoding="utf8") as file:
        pipeline = validate_index(json.load(file))
    files, variant = selected_files(info.siblings)
    for key in ["unet", "vae", "text_encoder"] + (["text_encoder_2"] if pipeline == "StableDiffusionXLPipeline" else []):
        if not any(name.startswith(key + "/") and name.endswith(".safetensors") for name in files):
            raise ValueError("Repository is missing safetensors for " + key)
    sizes = {item.rfilename: item.size for item in info.siblings}
    if any(sizes.get(name) is None for name in files):
        raise ValueError("Hugging Face did not return file sizes; cannot safely plan this download")
    total = sum(sizes[name] for name in files)
    if total > 20 * 1024**3:
        raise ValueError("Model exceeds the 20 GB download limit; choose a smaller image model")

    missing = sum(sizes[name] for name in files if not (directory / name).is_file() or (directory / name).stat().st_size != sizes[name])
    reserve = missing + max(sizes[name] for name in files) + 1024**3
    if shutil.disk_usage(directory).free < reserve:
        raise OSError("Insufficient disk space for staged model download; free space and retry")

    class Progress(tqdm):
        last_emit = 0
        def update(self, count=1):
            result = super().update(count)
            now = time.monotonic()
            if now - self.last_emit > 0.5:
                self.last_emit = now
                emit({"type": "progress", "message": "Downloading from Hugging Face…", "completed": self.n, "total": self.total, "unit": self.unit})
            return result

    snapshot_download(repo, revision=revision, token=token, local_dir=str(directory), allow_patterns=files, max_workers=2, tqdm_class=Progress)
    progress("Verifying downloaded model files…")
    records = []
    entries = {item.rfilename: item for item in info.siblings}
    for name in files:
        path = directory / name
        if not path.is_file() or not path.resolve().is_relative_to(directory.resolve()):
            raise ValueError("Model download is incomplete")
        if sizes.get(name) is not None and path.stat().st_size != sizes[name]:
            raise ValueError("Incomplete download: " + name)
        digest = hashlib.sha256()
        with open(path, "rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(chunk)
        entry = entries[name]
        lfs = entry.lfs
        expected = (lfs.get("sha256") if isinstance(lfs, dict) else getattr(lfs, "sha256", None)) if lfs else None
        if expected and digest.hexdigest() != expected:
            path.unlink()  # staging only: retry downloads the corrupt file; verified models are untouched
            raise ValueError("Model checksum mismatch: " + name)
        records.append({"path": name, "bytes": path.stat().st_size, "sha256": digest.hexdigest()})
    return {"repoId": repo, "revision": revision, "pipeline": pipeline, "variant": variant, "files": records, "bytes": sum(item["bytes"] for item in records), "downloadedAt": int(time.time() * 1000)}


def runtime_status(preference=None):
    import torch
    import diffusers
    import transformers
    import accelerate
    if preference == "cpu":
        device = "cpu"
        name = "CPU (explicit fallback)"
    elif torch.cuda.is_available():
        device = "cuda"
        name = torch.cuda.get_device_name(0)
    elif torch.backends.mps.is_available():
        device = "mps"
        name = "Apple Metal"
    else:
        device = "cpu"
        name = "CPU (generation will be slow)"
    return {"ready": True, "device": device, "deviceName": name, "torchVersion": torch.__version__, "diffusersVersion": diffusers.__version__}


def generate(request):
    # Prevent all Hub network activity during inference. Model downloads are explicit operations.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    model_path = Path(request["modelPath"])
    with open(model_path / "model_index.json", encoding="utf8") as file:
        pipeline_name = validate_index(json.load(file))
    width, height = map(int, request["size"].split("x"))
    turbo = request["repoId"] in {"stabilityai/sd-turbo", "stabilityai/sdxl-turbo"}
    if turbo:
        factor = 512 / max(width, height)
        width, height = max(256, int(width * factor) // 8 * 8), max(256, int(height * factor) // 8 * 8)
    if width * height > 1024 * 1024:
        raise ValueError("Local generation is limited to one megapixel. Choose a smaller image size.")

    # Recheck the model footprint inside the isolated worker before importing torch or allocating
    # a Metal heap. This protects callers that bypass the TypeScript preflight.
    model_bytes = sum(path.stat().st_size for path in model_path.rglob("*.safetensors") if path.is_file())
    memory_limit = int(request.get("memoryLimitBytes") or 0)
    host_memory = request.get("hostMemory") or {}
    free_memory = int(host_memory.get("freeBytes") or 0)
    multiplier = 1.55 if pipeline_name == "StableDiffusionXLPipeline" else 1.25
    estimated = int(model_bytes * multiplier + 2 * 1024**3)
    if memory_limit and estimated > memory_limit:
        raise MemoryError("The image model would exceed Eris's safe memory budget. Use SD-Turbo or free system memory.")
    minimum_free = (6 if pipeline_name == "StableDiffusionXLPipeline" else 3) * 1024**3
    if free_memory and free_memory < minimum_free:
        raise MemoryError("There is not enough free system memory to load this image model safely.")

    import torch
    from diffusers import StableDiffusionPipeline, StableDiffusionXLPipeline
    pipeline_type = StableDiffusionXLPipeline if pipeline_name == "StableDiffusionXLPipeline" else StableDiffusionPipeline
    device = "cpu" if request.get("devicePreference") == "cpu" else "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    dtype = torch.float32 if device == "cpu" else torch.float16
    gpu = None
    if device == "cuda":
        gpu = max(range(torch.cuda.device_count()), key=lambda index: torch.cuda.mem_get_info(index)[0])
        free = torch.cuda.mem_get_info(gpu)[0]
        minimum = 8 * 1024**3 if pipeline_name == "StableDiffusionXLPipeline" else 4 * 1024**3
        if free < minimum:
            raise MemoryError("The selected CUDA GPU does not have enough free memory for this image model.")
        torch.cuda.set_device(gpu)
    elif device == "mps" and hasattr(torch, "mps") and hasattr(torch.mps, "set_per_process_memory_fraction"):
        # Fail this worker at 60% of Metal's recommended working set instead of letting unified
        # memory pressure freeze the desktop. The process boundary then releases every allocation.
        torch.mps.set_per_process_memory_fraction(0.60)
    progress("Loading local image model on " + device + "…")
    options = {"torch_dtype": dtype, "local_files_only": True, "use_safetensors": True}
    if request.get("variant"):
        options["variant"] = request["variant"]
    steps = 2 if turbo else 20
    pipe = None
    try:
        pipe = pipeline_type.from_pretrained(str(model_path), **options)
        pipe.set_progress_bar_config(disable=True)
        pipe.enable_vae_slicing()
        if hasattr(pipe, "enable_vae_tiling"):
            pipe.enable_vae_tiling()
        if device == "cuda":
            if free < 10 * 1024**3 or pipeline_name == "StableDiffusionXLPipeline":
                pipe.enable_attention_slicing()
                pipe.enable_sequential_cpu_offload(gpu_id=gpu)
            else:
                pipe.enable_model_cpu_offload(gpu_id=gpu)
        else:
            if device == "cpu":
                torch.set_num_threads(min(4, os.cpu_count() or 1))
            elif device == "mps":
                pipe.enable_attention_slicing("max")
            pipe.to(device)
        progress("Generating locally on " + device + "…")
        def step_callback(_pipeline, step, _timestep, kwargs):
            emit({"type": "progress", "message": "Generating image…", "completed": step + 1, "total": steps, "unit": "steps"})
            return kwargs
        with torch.inference_mode():
            result = pipe(prompt=request["prompt"], width=width, height=height, num_inference_steps=steps,
                          guidance_scale=0.0 if turbo else 7.5, callback_on_step_end=step_callback)
        if getattr(result, "nsfw_content_detected", None) and any(result.nsfw_content_detected):
            raise ValueError("The local model did not return an image for this prompt")
        result.images[0].save(request["outputPath"], format="PNG")
        return {"device": device, "width": width, "height": height}
    finally:
        if pipe is not None:
            del pipe
        gc.collect()
        if device == "cuda":
            with contextlib.suppress(Exception):
                torch.cuda.empty_cache()
        elif device == "mps" and hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
            with contextlib.suppress(Exception):
                torch.mps.empty_cache()


def main():
    request = json.loads(sys.stdin.readline())
    try:
        # Libraries can print during loading. Keep the JSONL channel unambiguous.
        with contextlib.redirect_stdout(sys.stderr):
            operation = request["operation"]
            if operation == "status":
                result = runtime_status(request.get("devicePreference"))
            elif operation == "download":
                result = download(request)
            elif operation == "generate":
                result = generate(request)
            else:
                raise ValueError("Unknown local image operation")
        emit({"type": "result", "data": result})
    except Exception as error:
        message = str(error)
        if isinstance(error, ModuleNotFoundError):
            message = "Local image runtime needs setup: " + message
        elif isinstance(error, MemoryError) or "out of memory" in message.lower():
            message = "Image generation was stopped before it could exhaust system memory. Close memory-heavy apps, choose a smaller model, or use SD-Turbo."
        emit({"type": "error", "error": message[:2000]})
        sys.exit(1)


if __name__ == "__main__":
    main()
