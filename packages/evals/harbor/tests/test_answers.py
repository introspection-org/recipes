from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from introspection_harbor.answers import (
    decode,
    load_answers,
    read_answer,
    read_result,
)

# The cases @introspection-ai/mcp-fakes' test/answers.test.ts runs too, so both read answers alike.
CASES = json.loads(
    (Path(__file__).parents[2] / "testdata" / "fakes" / "answers.json").read_text()
)


class SharedCasesTest(unittest.TestCase):
    def _expect(self, read: dict, case: dict) -> None:
        if "value" in case:
            self.assertEqual(read, {"ok": True, "value": case["value"]})
        else:
            self.assertFalse(read["ok"])
            self.assertTrue(read["error"])
            self.assertEqual([issue["path"] for issue in read["issues"]], case["paths"])

    def test_read_answer(self) -> None:
        for case in CASES["readAnswer"]:
            with self.subTest(case["name"]):
                self._expect(read_answer(case["answer"], case["text"]), case)

    def test_read_result(self) -> None:
        for case in CASES["readResult"]:
            with self.subTest(case["name"]):
                read = read_result(case["answer"], case["text"], case.get("structured"))
                self._expect(read, case)


class AnswersTest(unittest.TestCase):
    def test_a_missing_structured_content_names_the_projection(self) -> None:
        read = read_result({"format": "json", "structured": True}, "{}")
        self.assertIn("no structuredContent", read["error"])
        self.assertIn("ATIF projection", read["error"])

    def test_an_issue_names_its_keyword(self) -> None:
        read = read_answer({"format": "json", "schema": {"type": "string"}}, "1")
        self.assertEqual(read["issues"][0]["keyword"], "type")

    def test_decode_names_the_suffix_it_misses(self) -> None:
        answer = {"format": "prefixed_json", "prefix": "Found: ", "suffix": " Done."}
        with self.assertRaisesRegex(ValueError, 'does not end with " Done."'):
            decode(answer, 'Found: {"n":2}')
        self.assertEqual(decode(answer, 'Found: {"n":2} Done.'), {"n": 2})

    def test_decode_refuses_an_unknown_format(self) -> None:
        with self.assertRaisesRegex(ValueError, "no format yaml"):
            decode({"format": "yaml"}, "a: 1")
        self.assertFalse(read_answer({"format": "yaml"}, "a: 1")["ok"])

    def test_load_answers_reads_each_fakes_answers_by_its_id(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            with self.assertRaisesRegex(ValueError, "No fake's answers.json under"):
                load_answers(directory)
            (directory / "attio").mkdir()
            (directory / "attio" / "answers.json").write_text(
                json.dumps({"list-records": {"format": "toon"}})
            )
            self.assertEqual(
                load_answers(directory), {"attio": {"list-records": {"format": "toon"}}}
            )
            with self.assertRaisesRegex(
                FileNotFoundError, "No fakes' answers directory"
            ):
                load_answers(directory / "missing")


if __name__ == "__main__":
    unittest.main()
