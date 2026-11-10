"""Remote Infinity reranking; Mem0 retains vector results on upstream failure."""

import json
from urllib.request import Request, urlopen

from mem0.configs.rerankers.base import BaseRerankerConfig
from mem0.reranker.base import BaseReranker
from mem0.utils.factory import RerankerFactory


class InfinityRerankerConfig(BaseRerankerConfig):
    model: str = "BAAI/bge-reranker-v2-m3"
    url: str = "http://reranker:7997/rerank"
    timeout: float = 30


class InfinityReranker(BaseReranker):
    def __init__(self, config):
        self.config = config

    def rerank(self, query, documents, top_k=None):
        if not documents:
            return []
        request = Request(
            self.config.url,
            data=json.dumps({
                "model": self.config.model,
                "query": query,
                "documents": [doc["memory"] for doc in documents],
                "top_n": top_k or self.config.top_k or len(documents),
            }).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=self.config.timeout) as response:
            results = json.load(response)["results"]
        return [
            {**documents[result["index"]], "rerank_score": float(result["relevance_score"])}
            for result in results
        ]


RerankerFactory.provider_to_class["infinity"] = (
    "infinity_reranker.InfinityReranker", InfinityRerankerConfig,
)
