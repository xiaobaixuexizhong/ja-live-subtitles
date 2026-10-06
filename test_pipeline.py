import asyncio
import json
import unittest
import wave
from pathlib import Path

import websockets


ROOT = Path(__file__).resolve().parent


class PipelineTest(unittest.TestCase):
    def test_japanese_audio_produces_chinese_subtitle(self):
        async def run():
            with wave.open(str(ROOT / "sample-ja.wav"), "rb") as source:
                self.assertEqual((source.getnchannels(), source.getsampwidth(), source.getframerate()), (1, 2, 16000))
                pcm = source.readframes(16000 * 10)
            async with websockets.connect("ws://127.0.0.1:8765/subtitles") as viewer:
                async with websockets.connect("ws://127.0.0.1:8765/ws") as socket:
                    ready = json.loads(await socket.recv())
                    self.assertEqual(ready["type"], "ready")
                    await socket.send(pcm)
                    subtitles = [json.loads(await asyncio.wait_for(socket.recv(), timeout=90)) for _ in range(2)]
                    mirrored = [json.loads(await asyncio.wait_for(viewer.recv(), timeout=10)) for _ in range(2)]
                    self.assertEqual(subtitles, mirrored)
                    for subtitle in subtitles:
                        self.assertEqual(subtitle["type"], "subtitle", subtitle)
                        self.assertTrue(subtitle["ja"])
                        self.assertTrue(subtitle["zh"])
                        self.assertNotEqual(subtitle["ja"], subtitle["zh"])
                        self.assertGreaterEqual(subtitle["asr_ms"], 0)
                        self.assertGreaterEqual(subtitle["mt_ms"], 0)
                    self.assertLess(subtitles[0]["end"], subtitles[1]["end"])
                cleared = json.loads(await asyncio.wait_for(viewer.recv(), timeout=10))
                self.assertEqual(cleared["type"], "clear")
                return subtitles

        subtitles = asyncio.run(run())
        print(json.dumps(subtitles, ensure_ascii=True))


if __name__ == "__main__":
    unittest.main()
