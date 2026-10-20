"""Turn one long recording of Nouria's lines (e.g. ChatGPT "Read aloud" captured with Bandicam)
into one MP3 per line, ready to upload on the admin page (Settings -> Nouria -> a group -> upload).

    pip install pyaudiowpatch lameenc numpy faster-whisper miniaudio

    python scripts/mascot-voice.py record OUT.wav            # records the PC's sound until OUT.STOP exists
    python scripts/mascot-voice.py align  REC.wav SPEC.json  # cuts REC.wav into clips in .mascot-voice-stage/

SPEC.json lists the lines in the order they were spoken: [["label", "exact text"], ...].
Labels starting with "_" (section titles, ad-libs) are aligned but not kept. Alignment uses local
speech recognition (faster-whisper) + an exact character alignment against the known text, so pauses
between lines don't need to be long. Clips are named <label>.mp3 (label "ar/lunch-0" -> ar/lunch-0.mp3).
"""
import json
import sys
import time
import wave
from pathlib import Path

import numpy as np

WEB = Path(__file__).resolve().parent.parent
STAGE = WEB / 'scripts' / '.mascot-voice-stage'



# ───────────────────────── record ─────────────────────────

def cmd_record(target: str) -> None:
    import pyaudiowpatch as pa

    stop_file = Path(target).with_suffix('.STOP')
    stop_file.unlink(missing_ok=True)
    p = pa.PyAudio()
    wasapi = p.get_host_api_info_by_type(pa.paWASAPI)
    speakers = p.get_device_info_by_index(wasapi['defaultOutputDevice'])
    device = next(d for d in p.get_loopback_device_info_generator() if speakers['name'] in d['name'])
    rate, channels = int(device['defaultSampleRate']), device['maxInputChannels']

    frames: list[bytes] = []
    peak = [0]

    # Callback mode: only what the sound card actually plays is stored. (WASAPI loopback simply
    # delivers nothing while the PC is silent; never pad from a polling loop - that inserts
    # silence in the middle of speech.)
    def on_audio(data, _count, _time, _status):
        frames.append(data)
        peak[0] = max(peak[0], int(np.abs(np.frombuffer(data, np.int16)).max(initial=0)))
        return (None, pa.paContinue)

    stream = p.open(format=pa.paInt16, channels=channels, rate=rate, input=True,
                    input_device_index=device['index'], frames_per_buffer=1024, stream_callback=on_audio)
    print(f'recording "{device["name"]}" at {rate} Hz; create {stop_file.name} to stop', flush=True)
    started = time.time()
    try:
        while not stop_file.exists() and time.time() - started < 45 * 60:
            time.sleep(5)
            print(f'{time.time() - started:6.0f}s  peak level {peak[0]}', flush=True)
            peak[0] = 0
    finally:
        stream.stop_stream(); stream.close(); p.terminate()
    with wave.open(target, 'wb') as w:
        w.setnchannels(channels); w.setsampwidth(2); w.setframerate(rate); w.writeframes(b''.join(frames))
    print(f'saved {target} ({time.time() - started:.0f}s)', flush=True)


# ───────────────────────── audio helpers ─────────────────────────

FRAME = 0.02  # seconds per analysis frame


def load_mono(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path, 'rb') as w:
        rate, ch = w.getframerate(), w.getnchannels()
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    return (x.reshape(-1, ch).mean(axis=1) if ch > 1 else x), rate


def speech_regions(x: np.ndarray, rate: int) -> list[tuple[int, int]]:
    """Voiced regions as (start_frame, end_frame), from frame energy with an adaptive threshold."""
    n = int(rate * FRAME)
    frames = x[: len(x) // n * n].reshape(-1, n)
    db = 20 * np.log10(np.sqrt((frames ** 2).mean(axis=1)) + 1e-9)
    loud = np.percentile(db[db > -90], 95) if (db > -90).any() else -20
    voiced = db > loud - 32
    regions, start = [], None
    for i, v in enumerate(voiced):
        if v and start is None:
            start = i
        elif not v and start is not None:
            regions.append((start, i)); start = None
    if start is not None:
        regions.append((start, len(voiced)))
    # merge tiny blips (< 60 ms gaps) and drop clicks (< 120 ms)
    merged: list[list[int]] = []
    for s, e in regions:
        if merged and s - merged[-1][1] < 3:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    return [(s, e) for s, e in merged if e - s >= 6]


def to_mp3(x: np.ndarray, rate: int, path: Path) -> None:
    import lameenc
    target_rate = 24000
    idx = np.arange(0, len(x), rate / target_rate)
    y = np.interp(idx, np.arange(len(x)), x)
    peak = np.abs(y).max() or 1
    y = (y / peak * 0.89 * 32767).astype(np.int16)  # normalise loudness across clips
    enc = lameenc.Encoder()
    enc.set_bit_rate(64); enc.set_in_sample_rate(target_rate); enc.set_channels(1); enc.set_quality(2)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(enc.encode(y.tobytes()) + enc.flush())



# ───────────────────────── align ─────────────────────────
# Read-aloud voices run lines together with pauses no longer than those inside a line, so pauses
# alone can't find the boundaries. Instead: local speech recognition (faster-whisper) gives a time
# for every recognised character, the recognised text is aligned to the known lines character by
# character, and each cut is snapped to the quietest moment between two lines.

import re
import unicodedata

_DIACRITICS = re.compile(r'[ؐ-ًؚ-ٰٟۖ-ۭـ]')


def norm(text: str) -> str:
    t = _DIACRITICS.sub('', unicodedata.normalize('NFKC', text))
    t = t.translate(str.maketrans('أإآٱىةؤئ', 'اااايهوي'))
    return re.sub(r'[^\w]', '', t)  # letters/digits only; spaces and punctuation don't help alignment


def lcs_pairs(a: list[str], b: list[str]) -> list[tuple[int, int]]:
    """Index pairs of a longest common subsequence (exact DP; difflib's greedy blocks mis-assign
    short lines when the recognised text is noisy)."""
    n, m = len(a), len(b)
    dp = np.zeros((n + 1, m + 1), dtype=np.int32)
    for i in range(n - 1, -1, -1):
        ai, row, nxt = a[i], dp[i], dp[i + 1]
        for j in range(m - 1, -1, -1):
            row[j] = nxt[j + 1] + 1 if ai == b[j] else max(nxt[j], row[j + 1])
    pairs, i, j = [], 0, 0
    while i < n and j < m:
        if a[i] == b[j]:
            pairs.append((i, j)); i += 1; j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            i += 1
        else:
            j += 1
    return pairs


def stage_clip_path(label: str) -> Path:
    """STAGE/<label>.mp3, refusing labels that would write outside the stage folder."""
    if not isinstance(label, str) or not label.strip():
        raise SystemExit(f'invalid label {label!r}: must be a non-empty name')
    if any(c in label for c in '/' + chr(92) + ':' + chr(0)) or label in ('.', '..') or '..' in label:
        raise SystemExit(f'invalid label {label!r}: no path separators, drive letters or ".."')
    stage = STAGE.resolve()
    target = (stage / f'{label}.mp3').resolve()
    if target.parent != stage:
        raise SystemExit(f'invalid label {label!r}: resolves outside {stage}')
    return target


def cmd_align(source: str, spec: str = '', model_size: str = 'small') -> None:
    """spec (optional): JSON file [[key, text], ...] in the order spoken; default = lines-data.json."""
    from faster_whisper import WhisperModel

    x, rate = load_mono(source)
    model = WhisperModel(model_size, device='cpu', compute_type='int8')
    if not spec:
        raise SystemExit('align needs SPEC.json: [["label", "exact text"], ...] in spoken order')
    lines = [tuple(item) for item in json.loads(Path(spec).read_text(encoding='utf-8'))]
    for label, _ in lines:
        stage_clip_path(label)  # fail fast, before the slow recognition pass
    segments, _ = model.transcribe(
        x if rate == 16000 else np.interp(np.arange(0, len(x), rate / 16000), np.arange(len(x)), x).astype(np.float32),
        # No initial_prompt: priming with the known lines made the model skip the opening lines.
        language='ar', word_timestamps=True, vad_filter=True,
    )
    # Recognised characters with the time of the word they belong to.
    hyp, hyp_t = [], []
    for seg in segments:
        for w in seg.words or []:
            for ch in norm(w.word):
                hyp.append(ch); hyp_t.append((w.start, w.end))
    # Known text, each character tagged with its line.
    ref, ref_line = [], []
    for i, (_, text) in enumerate(lines):
        for ch in norm(text):
            ref.append(ch); ref_line.append(i)

    matched = [[] for _ in lines]  # times of matched characters per line
    for a, b in lcs_pairs(ref, hyp):
        matched[ref_line[a]].append(hyp_t[b])

    coverage = [len(m) / max(1, sum(1 for l in ref_line if l == i)) for i, m in enumerate(matched)]
    spans = [(min(s for s, _ in m), max(e for _, e in m)) if m else None for m in matched]
    # A line the recogniser missed between two found lines is the stretch between them.
    for i, s in enumerate(spans):
        if s is None and 0 < i < len(spans) - 1 and spans[i - 1] and spans[i + 1]                 and spans[i + 1][0] - spans[i - 1][1] >= 0.6:
            spans[i] = (spans[i - 1][1] + 0.05, spans[i + 1][0] - 0.05)
            print(f'{lines[i][0]}: not recognised, taken from the gap between its neighbours  <-- check')
        elif s is None and 0 < i < len(spans) - 1 and spans[i - 1] and spans[i + 1]:
            # Neighbours swallowed its letters: share their combined stretch by text length.
            start, end = spans[i - 1][0], spans[i + 1][1]
            sizes = [len(norm(lines[k][1])) for k in (i - 1, i, i + 1)]
            a = start + (end - start) * sizes[0] / sum(sizes)
            b = start + (end - start) * (sizes[0] + sizes[1]) / sum(sizes)
            spans[i - 1], spans[i], spans[i + 1] = (start, a), (a, b), (b, end)
            print(f'{lines[i][0]}: not recognised, split from its neighbours by length  <-- check')
    missing = [lines[i][0] for i, s in enumerate(spans) if s is None]
    if missing:
        print('could not find these lines in the recording:', ', '.join(missing)); return

    # Cut between consecutive lines at the quietest 20 ms frame in the gap between them.
    n = int(rate * FRAME)
    energy = np.sqrt((x[: len(x) // n * n].reshape(-1, n) ** 2).mean(axis=1))
    def quietest(t0: float, t1: float) -> float:
        a, b = int(t0 / FRAME), max(int(t0 / FRAME) + 1, int(t1 / FRAME))
        return (a + int(np.argmin(energy[a:b]))) * FRAME
    cuts = [max(0.0, spans[0][0] - 0.25)]
    for i in range(len(spans) - 1):
        end_i, start_next = spans[i][1], spans[i + 1][0]
        lo, hi = min(end_i, start_next) - 0.15, max(end_i, start_next) + 0.15
        cuts.append(quietest(lo, hi))
    cuts.append(min(len(x) / rate, spans[-1][1] + 0.35))

    staged = {}
    for i, (key, text) in enumerate(lines):
        a, b = int(cuts[i] * rate), int(cuts[i + 1] * rate)
        clip = x[a:b]
        if len(clip) < int(0.3 * rate):
            print(f'{key}: cut too short, skipped  <-- check'); continue
        # trim silence at both ends, keeping a short natural lead-in/out
        fe = np.sqrt((clip[: len(clip) // n * n].reshape(-1, n) ** 2).mean(axis=1))
        voiced = np.where(fe > fe.max() * 0.04)[0] if len(fe) else np.array([])
        if len(voiced):
            clip = clip[max(0, (voiced[0] - 4) * n): (voiced[-1] + 6) * n]
        if key.startswith('_'):  # spoken but unwanted (section titles, ad-libs): aligned, never kept
            continue
        to_mp3(clip, rate, stage_clip_path(key))
        staged[key] = text
        flag = '  <-- check' if coverage[i] < 0.6 else ''
        print(f'{key:28s} {len(clip) / rate:5.1f}s  matched {coverage[i]:4.0%}{flag}')
    (STAGE / 'staged.json').write_text(json.dumps(staged, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'\n{len(staged)} clips staged in {STAGE}')



if __name__ == '__main__':
    cmd, *args = sys.argv[1:] or ['help']
    {'record': cmd_record, 'align': cmd_align}.get(
        cmd, lambda *_: print(__doc__))(*args)
