import unittest

import asyncio
import json

from app import (
    build_batch_translation_prompt,
    build_translation_prompt,
    parse_batch_translation_response,
    request_ollama_translation_batch,
    split_translation_segments,
)


class TranslationContextTest(unittest.TestCase):
    def test_prompt_keeps_previous_context_separate_from_current_text(self):
        prompt = build_translation_prompt(
            "それは本当ですか",
            {
                "previousSource": "昨日の話ですが",
                "previousTranslation": "说起昨天的事",
            },
        )
        self.assertIn("说起昨天的事", prompt)
        self.assertIn("当前需要翻译的字幕", prompt)
        self.assertTrue(prompt.endswith("それは本当ですか"))

    def test_prompt_without_context_stays_unchanged(self):
        self.assertEqual(build_translation_prompt("短句", {}), "短句")

    def test_batch_prompt_contains_all_current_segments(self):
        prompt = build_batch_translation_prompt(
            [{"i": 2, "text": "前半句"}, {"i": 3, "text": "后半句"}],
            {"previousSource": "前文"},
            "日语",
        )
        self.assertIn('"i": 2', prompt)
        self.assertIn("前半句", prompt)
        self.assertIn("后半句", prompt)
        self.assertIn("前文", prompt)

    def test_batch_prompt_includes_glossary(self):
        prompt = build_batch_translation_prompt(
            [{"i": 0, "text": "テスト"}],
            {"glossary": "テスト=测试"},
            "日语",
        )
        self.assertIn("テスト=测试", prompt)

    def test_segments_are_split_by_count_and_source_length(self):
        segments = [{"i": index, "text": "日" * 700} for index in range(20)]
        batches = split_translation_segments(segments)
        self.assertGreater(len(batches), 1)
        self.assertEqual([item["i"] for batch in batches for item in batch], list(range(20)))
        self.assertTrue(all(len(batch) <= 12 for batch in batches))

    def test_batch_response_keeps_indexes(self):
        response = json.dumps({"items": [{"i": 4, "text": "甲"}, {"i": 5, "text": "乙"}]})
        self.assertEqual(
            parse_batch_translation_response(response, [{"i": 4, "text": "a"}, {"i": 5, "text": "b"}]),
            [{"i": 4, "text": "甲"}, {"i": 5, "text": "乙"}],
        )

    def test_model_batch_uses_one_request_for_multiple_segments(self):
        class Response:
            def raise_for_status(self):
                return None

            def json(self):
                return {"message": {"content": '{"items":[{"i":0,"text":"甲"},{"i":1,"text":"乙"}]}'} }

        class Client:
            def __init__(self):
                self.calls = 0

            async def post(self, *args, **kwargs):
                self.calls += 1
                return Response()

        client = Client()
        result = asyncio.run(request_ollama_translation_batch(
            client,
            "model",
            [{"i": 0, "text": "一"}, {"i": 1, "text": "二"}],
            {},
            "日语",
        ))
        self.assertEqual(client.calls, 1)
        self.assertEqual(result[1]["text"], "乙")


if __name__ == "__main__":
    unittest.main()
