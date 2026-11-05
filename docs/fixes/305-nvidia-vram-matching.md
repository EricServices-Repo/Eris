# #305 — nvidia-smi memory goes only to the card it describes

The issue's MO-05 asks for hardware admission from known device capacity, and its
acceptance criteria say unknown device data must stay conservative.

## Defect

On Windows, `Win32_VideoController.AdapterRAM` is a 32-bit field, so Eris replaces it
with `nvidia-smi` totals and free memory. `enrichNvidiaVram` picked the first
`nvidia-smi` row whose name contained the adapter's name, **or contained the
adapter's first 12 characters**. Every NVIDIA consumer card starts with
`nvidia gefor`, so with a GTX 1050 (2 GiB) and an RTX 4090 (24 GiB) listed in that
order, the 1050 received the 4090's 24 GiB total and its free memory.

The free figure feeds `inferenceBudgetBytes` through `preferredGpu`, so the
admission budget could describe a card that was not the one being measured. Two
cards with the same name also both got the first card's free memory, even when the
second was busy.

## Change

`matchNvidiaVram` (exported for tests) uses a figure only for an adapter with exactly
the same name, ignoring case and repeated spaces. This is the same rule
`llamaGpuPreferenceEnv` already used to map the preferred adapter to a CUDA ID.

- No same-name row: the OS figure is kept.
- Several rows with one name: the OS listing cannot say which is which, so each
  adapter gets the smallest total and the smallest free memory in the group.
- A reported total is still never lowered.

## Tests

`tests/gpu-accel.test.ts` covers the shared-prefix case, an unlisted adapter, two
same-name cards with different free memory, and case/space normalization. All four
fail against the previous matching code.

## Limits

- Scripted inputs only. No multi-GPU Windows host was measured.
- Same-name cards are not mapped to physical PCI slots. That would need the PNP
  location from the OS and `pci.bus_id` from `nvidia-smi`.
