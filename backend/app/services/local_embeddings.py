# backend/app/services/local_embeddings.py
"""Local embedding service using sentence-transformers."""
import struct
from typing import List, Tuple

import numpy as np
from sentence_transformers import SentenceTransformer


class LocalEmbeddingService:
    """Service for generating and comparing text embeddings locally."""

    MODEL = "all-MiniLM-L6-v2"
    EMBEDDING_DIM = 384

    def __init__(self, model_name: str = None):
        """Initialize the local embedding service.

        Args:
            model_name: Optional model name override. Defaults to MODEL.
        """
        model_to_load = model_name or self.MODEL
        self.model = SentenceTransformer(model_to_load)

    def get_embedding(self, text: str) -> List[float]:
        """Get embedding vector for a text.

        Args:
            text: Text to embed.

        Returns:
            List of floats representing the embedding vector (384 dimensions).
        """
        embedding = self.model.encode(text, convert_to_numpy=True)
        return embedding.tolist()

    def serialize_embedding(self, embedding: List[float]) -> bytes:
        """Serialize an embedding vector for storage.

        Uses binary format for efficient storage.

        Args:
            embedding: List of floats representing the embedding.

        Returns:
            Bytes representation of the embedding.
        """
        # Each float is 4 bytes, header includes dimension count
        return struct.pack(f"I{len(embedding)}f", len(embedding), *embedding)

    def deserialize_embedding(self, data: bytes) -> List[float]:
        """Deserialize an embedding vector from storage.

        Args:
            data: Bytes representation of the embedding.

        Returns:
            List of floats representing the embedding.
        """
        # Unpack dimension count first, then the floats
        dim = struct.unpack_from("I", data)[0]
        floats = struct.unpack_from(f"{dim}f", data, 4)
        return list(floats)

    @staticmethod
    def cosine_similarity(vec1: List[float], vec2: List[float]) -> float:
        """Calculate cosine similarity between two vectors.

        Args:
            vec1: First vector.
            vec2: Second vector.

        Returns:
            Cosine similarity value between -1 and 1.
        """
        vec1_np = np.array(vec1)
        vec2_np = np.array(vec2)

        dot_product = np.dot(vec1_np, vec2_np)
        norm1 = np.linalg.norm(vec1_np)
        norm2 = np.linalg.norm(vec2_np)

        if norm1 == 0 or norm2 == 0:
            return 0.0

        return float(dot_product / (norm1 * norm2))

    def find_similar_chunks(
        self,
        query_embedding: List[float],
        chunks_with_embeddings: List[Tuple[int, str, bytes]],
        top_k: int = 5,
        min_similarity: float = 0.0,
    ) -> List[Tuple[int, str, float]]:
        """Find the most similar chunks to a query embedding.

        Args:
            query_embedding: Query embedding vector.
            chunks_with_embeddings: List of tuples (chunk_id, content, embedding_bytes).
            top_k: Number of top results to return.
            min_similarity: Minimum similarity threshold.

        Returns:
            List of tuples (chunk_id, content, similarity_score), sorted by similarity.
        """
        if not chunks_with_embeddings:
            return []

        results = []

        for chunk_id, content, embedding_bytes in chunks_with_embeddings:
            chunk_embedding = self.deserialize_embedding(embedding_bytes)
            similarity = self.cosine_similarity(query_embedding, chunk_embedding)

            if similarity >= min_similarity:
                results.append((chunk_id, content, similarity))

        # Sort by similarity score descending
        results.sort(key=lambda x: x[2], reverse=True)

        return results[:top_k]