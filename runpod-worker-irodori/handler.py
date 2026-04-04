import base64
import io
import json
import os
import traceback
from pathlib import Path

import runpod
import soundfile as sf

from irodori_tts.inference_runtime import (
    RuntimeKey,
    SamplingRequest,
    get_cached_runtime,
    resolve_cfg_scales,
)

CHECKPOINT_PATH = os.environ.get("IRODORI_CHECKPOINT", "/app/models/model.safetensors")
MODEL_DEVICE = os.environ.get("IRODORI_MODEL_DEVICE", "cuda")
CODEC_DEVICE = os.environ.get("IRODORI_CODEC_DEVICE", MODEL_DEVICE)
MODEL_PRECISION = os.environ.get("IRODORI_MODEL_PRECISION", "bf16")
CODEC_PRECISION = os.environ.get("IRODORI_CODEC_PRECISION", "bf16")
CODEC_REPO = os.environ.get("IRODORI_CODEC_REPO", "Aratako/Semantic-DACVAE-Japanese-32dim")
DEFAULT_NUM_STEPS = int(os.environ.get("IRODORI_DEFAULT_NUM_STEPS", "40"))
MAX_SECONDS = float(os.environ.get("IRODORI_MAX_SECONDS", "45"))
MAX_NUM_STEPS = int(os.environ.get("IRODORI_MAX_NUM_STEPS", "80"))
MAX_TEXT_LENGTH = int(os.environ.get("IRODORI_MAX_TEXT_LENGTH", "100"))
MAX_REFERENCE_TEXT_LENGTH = int(os.environ.get("IRODORI_MAX_REFERENCE_TEXT_LENGTH", "300"))


def _normalize_job_input(job_input):
    if job_input is None:
        return {}
    if isinstance(job_input, str):
        try:
            job_input = json.loads(job_input)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON input: {exc}")
    if not isinstance(job_input, dict):
        raise ValueError("Input must be an object.")
    if isinstance(job_input.get("input"), dict):
        return job_input["input"]
    return job_input


def _clamp(value, minimum, maximum):
    return max(minimum, min(maximum, value))


def _estimate_seconds(text: str) -> float:
    estimated = (len(text) / 4.0) + 2.0
    return float(_clamp(estimated, 6.0, MAX_SECONDS))


def _normalize_precision(value: str | None, default_value: str) -> str:
    normalized = (value or "").strip().lower()
    if not normalized:
        return default_value
    if normalized in {"fp16", "float16", "half"}:
        return "fp32"
    if normalized in {"fp32", "bf16"}:
        return normalized
    return default_value


def _build_runtime_key(checkpoint_path: str, model_precision: str, codec_precision: str) -> RuntimeKey:
    return RuntimeKey(
        checkpoint=checkpoint_path,
        model_device=MODEL_DEVICE,
        codec_repo=CODEC_REPO,
        model_precision=model_precision,
        codec_device=CODEC_DEVICE,
        codec_precision=codec_precision,
        codec_deterministic_encode=True,
        codec_deterministic_decode=True,
        enable_watermark=False,
        compile_model=False,
        compile_dynamic=False,
    )


def _tensor_to_wav_base64(audio_tensor, sample_rate: int) -> str:
    buf = io.BytesIO()
    wav = audio_tensor.squeeze(0).detach().float().cpu().numpy()
    sf.write(buf, wav, sample_rate, format="WAV")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _is_bf16_unsupported_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return "bfloat16" in msg and ("unsupported" in msg or "not implemented" in msg)


def _run_synthesize(
    checkpoint: Path,
    request: SamplingRequest,
    model_precision: str,
    codec_precision: str,
):
    runtime, reloaded = get_cached_runtime(
        _build_runtime_key(
            str(checkpoint),
            model_precision=model_precision,
            codec_precision=codec_precision,
        )
    )
    result = runtime.synthesize(request)
    return result, reloaded


def handler(job):
    try:
        data = _normalize_job_input(job.get("input"))
        text = str(data.get("text", "")).strip()
        if text == "":
            return {"error": "text is required."}
        if len(text) > MAX_TEXT_LENGTH:
            return {"error": f"text is too long (max {MAX_TEXT_LENGTH})."}

        checkpoint = Path(CHECKPOINT_PATH)
        if not checkpoint.is_file():
            return {"error": f"Checkpoint not found: {checkpoint}"}

        reference_text = str(data.get("reference_text") or "").strip()
        if len(reference_text) > MAX_REFERENCE_TEXT_LENGTH:
            return {"error": f"reference_text is too long (max {MAX_REFERENCE_TEXT_LENGTH})."}

        seconds_raw = data.get("seconds")
        if seconds_raw is None:
            seconds = _estimate_seconds(text)
        else:
            seconds = float(seconds_raw)
        seconds = float(_clamp(seconds, 2.0, MAX_SECONDS))

        num_steps_raw = data.get("num_steps")
        num_steps = DEFAULT_NUM_STEPS if num_steps_raw is None else int(num_steps_raw)
        num_steps = int(_clamp(num_steps, 4, MAX_NUM_STEPS))

        seed = data.get("seed")
        seed = None if seed in (None, "") else int(seed)

        cfg_scale_text, cfg_scale_caption, cfg_scale_speaker, scale_messages = resolve_cfg_scales(
            cfg_guidance_mode="independent",
            cfg_scale_text=float(data.get("cfg_scale_text", 3.0)),
            cfg_scale_caption=float(data.get("cfg_scale_caption", 3.0)),
            cfg_scale_speaker=float(data.get("cfg_scale_speaker", 5.0)),
            cfg_scale=None,
            use_caption_condition=True,
            use_speaker_condition=False,
        )

        sampling_request = SamplingRequest(
            text=text,
            caption=(reference_text or None),
            ref_wav=None,
            ref_latent=None,
            no_ref=True,
            ref_normalize_db=None,
            ref_ensure_max=False,
            num_candidates=1,
            decode_mode="sequential",
            seconds=seconds,
            max_ref_seconds=30.0,
            max_text_len=None,
            max_caption_len=None,
            num_steps=num_steps,
            seed=seed,
            cfg_guidance_mode="independent",
            cfg_scale_text=float(cfg_scale_text),
            cfg_scale_caption=float(cfg_scale_caption),
            cfg_scale_speaker=float(cfg_scale_speaker),
            cfg_scale=None,
            cfg_min_t=0.5,
            cfg_max_t=1.0,
            truncation_factor=None,
            rescale_k=None,
            rescale_sigma=None,
            context_kv_cache=True,
            speaker_kv_scale=None,
            speaker_kv_min_t=None,
            speaker_kv_max_layers=None,
            trim_tail=True,
        )

        requested_model_precision = _normalize_precision(MODEL_PRECISION, "bf16")
        requested_codec_precision = _normalize_precision(CODEC_PRECISION, "bf16")
        used_model_precision = requested_model_precision
        used_codec_precision = requested_codec_precision

        try:
            result, reloaded = _run_synthesize(
                checkpoint,
                sampling_request,
                model_precision=used_model_precision,
                codec_precision=used_codec_precision,
            )
        except Exception as first_exc:
            can_fallback = (
                _is_bf16_unsupported_error(first_exc)
                and (used_model_precision == "bf16" or used_codec_precision == "bf16")
            )
            if not can_fallback:
                raise

            fallback_model_precision = "fp32" if used_model_precision == "bf16" else used_model_precision
            fallback_codec_precision = "fp32" if used_codec_precision == "bf16" else used_codec_precision
            result, reloaded = _run_synthesize(
                checkpoint,
                sampling_request,
                model_precision=fallback_model_precision,
                codec_precision=fallback_codec_precision,
            )
            scale_messages.append("bf16 unsupported on this worker. Automatically retried with fp32.")
            used_model_precision = fallback_model_precision
            used_codec_precision = fallback_codec_precision

        audio_b64 = _tensor_to_wav_base64(result.audio, result.sample_rate)

        ignored_ref_audio = bool(
            data.get("reference_audio_base64")
            or data.get("ref_audio_base64")
            or data.get("reference_audio")
        )

        messages = [*scale_messages, *result.messages]
        if ignored_ref_audio:
            messages.append("reference_audio was provided but ignored (VoiceDesign-only worker).")

        output = {
            "audio_base64": audio_b64,
            "audio_mime": "audio/wav",
            "sample_rate": int(result.sample_rate),
            "seed": int(result.used_seed),
            "seconds": float(seconds),
            "num_steps": int(num_steps),
            "runtime_reloaded": bool(reloaded),
            "model_variant": "voicedesign",
            "model_precision": used_model_precision,
            "codec_precision": used_codec_precision,
            "messages": messages,
        }

        if reference_text:
            output["reference_text"] = reference_text

        return output
    except Exception as exc:
        return {
            "error": str(exc),
            "traceback": traceback.format_exc(limit=4),
        }


runpod.serverless.start({"handler": handler})
