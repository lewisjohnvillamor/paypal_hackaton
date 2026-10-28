# Speaks each line of a lines file into <out>/<key>.wav and writes <out>/durations.json.
# Uses Kokoro (Apache-2.0 model, runs offline): pip install kokoro-onnx soundfile, and the model
# files kokoro-v1.0.onnx and voices-v1.0.bin from github.com/thewh1teagle/kokoro-onnx releases.
# Usage: python3 scripts/voice/tts.py scripts/voice/agent-video-lines.json data/voice [model-dir]
import json, sys, os
import soundfile as sf
from kokoro_onnx import Kokoro

lines_file, out = sys.argv[1], sys.argv[2]
models = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("KOKORO_DIR", ".")
voice = os.environ.get("VOICE", "af_heart")
speed = float(os.environ.get("VOICE_SPEED", "1.05"))
k = Kokoro(f"{models}/kokoro-v1.0.onnx", f"{models}/voices-v1.0.bin")
os.makedirs(out, exist_ok=True)
durations = {}
for key, text in json.load(open(lines_file)).items():
    samples, rate = k.create(text.replace("“", "").replace("”", "").replace("…", ","), voice=voice, speed=speed, lang="en-us")
    sf.write(f"{out}/{key}.wav", samples, rate)
    durations[key] = round(len(samples) / rate, 2)
    print(key, durations[key])
json.dump(durations, open(f"{out}/durations.json", "w"), indent=1)
print("total", round(sum(durations.values()), 1))
