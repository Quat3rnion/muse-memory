import json
import unittest
from unittest.mock import patch, MagicMock

from infinity_reranker import InfinityReranker, InfinityRerankerConfig


class InfinityRerankerTest(unittest.TestCase):
    def test_http_ranking_preserves_documents(self):
        reranker = InfinityReranker(InfinityRerankerConfig())
        documents = [{"memory": "unrelated", "id": "a"}, {"memory": "relevant", "id": "b"}]
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            "results": [{"index": 1, "relevance_score": 0.9}]
        }).encode()
        with patch("infinity_reranker.urlopen", return_value=response) as call:
            result = reranker.rerank("query", documents, top_k=1)
        self.assertEqual(result, [{"memory": "relevant", "id": "b", "rerank_score": 0.9}])
        self.assertNotIn("rerank_score", documents[1])
        request = call.call_args.args[0]
        self.assertEqual(request.full_url, "http://reranker:7997/rerank")
        self.assertEqual(json.loads(request.data), {
            "model": "BAAI/bge-reranker-v2-m3", "query": "query",
            "documents": ["unrelated", "relevant"], "top_n": 1,
        })

    def test_empty_skips_http(self):
        with patch("infinity_reranker.urlopen") as call:
            self.assertEqual(InfinityReranker(InfinityRerankerConfig()).rerank("q", []), [])
        call.assert_not_called()

    def test_failure_propagates_to_mem0_fallback(self):
        with patch("infinity_reranker.urlopen", side_effect=TimeoutError):
            with self.assertRaises(TimeoutError):
                InfinityReranker(InfinityRerankerConfig()).rerank("q", [{"memory": "m"}])


if __name__ == "__main__":
    unittest.main()
