from typing import List, Optional, Tuple
from sqlalchemy.orm import Session
from app.models import CannedResponse


class CannedResponseService:

    def find_relevant(
        self,
        query_embedding: List[float],
        platform_id: int,
        db: Session,
        top_k: int = 2,
        min_similarity: float = 0.50,
    ) -> List[Tuple[str, str, float]]:
        """Return (title, content, similarity) for top matching canned responses.

        Searches platform-specific responses + B2C General (platform_id IS NULL).
        """
        from sqlalchemy import or_
        responses = (
            db.query(CannedResponse)
            .filter(
                CannedResponse.embedding.isnot(None),
                or_(
                    CannedResponse.platform_id == platform_id,
                    CannedResponse.platform_id.is_(None),
                ),
            )
            .all()
        )

        if not responses:
            return []

        from app.services.local_embeddings import LocalEmbeddingService
        embedding_service = LocalEmbeddingService()

        chunks = [
            (r.id, r.title + "\n" + r.content, r.embedding)
            for r in responses
        ]
        id_to_response = {r.id: r for r in responses}

        similar = embedding_service.find_similar_chunks(
            query_embedding=query_embedding,
            chunks_with_embeddings=chunks,
            top_k=top_k,
            min_similarity=min_similarity,
        )

        return [
            (id_to_response[chunk_id].title, id_to_response[chunk_id].content, similarity)
            for chunk_id, _, similarity in similar
        ]
