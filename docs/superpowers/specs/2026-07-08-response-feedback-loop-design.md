# Feedback loop de respuestas generadas — Diseño

**Fecha:** 2026-07-08
**Estado:** Aprobado por Erick

## Objetivo

Que el bot mejore con cada interacción: cada respuesta generada se puede calificar 👍/👎.
Las 👎 van a un queue donde el developer (Erick) escribe la respuesta correcta.
Los 👍 y las correcciones se inyectan como ejemplos few-shot en futuras interacciones
similares (similitud por embeddings). Sin calificación, el flujo actual no cambia en nada.

## Decisiones tomadas

- **Mecanismo de aprendizaje:** ejemplos few-shot recuperados por similitud de embeddings
  (enfoque A). Sin fine-tuning, sin convertir correcciones en canned responses.
- **Corrección en el queue:** el developer escribe la respuesta correcta completa
  (no notas/reglas sueltas).
- **Dónde se califica:** en Generate (respuesta recién generada, cubre manual/Freshdesk/
  Full Automated) y en History (respuestas pasadas).
- **Queue:** página nueva "Review Queue" en el hamburger menu, visible solo superadmin,
  con badge de pendientes.

## 1. Datos — `response_history` (3 columnas nuevas)

| Columna | Tipo | Uso |
|---|---|---|
| `message_embedding` | LargeBinary NULL | Embedding del `customer_message`, calculado al calificar (lazy: no se gasta en respuestas sin calificar). Serializado con `LocalEmbeddingService.serialize_embedding`. |
| `corrected_response` | Text NULL | La corrección del developer desde el queue. |
| `review_status` | String NULL | Solo para 👎: `pending` → `corrected` \| `dismissed`. |

`feedback` ya existe (`'useful'`/`'not_useful'`/NULL) y se reusa tal cual.
Migración: `ALTER TABLE` directo sobre SQLite (patrón existente del proyecto).

## 2. Backend

### Endpoints
- **`PATCH /history/{id}/feedback`** (existe, se extiende): al calificar calcula y guarda
  `message_embedding`; si es `not_useful` pone `review_status='pending'`; si se cambia de
  👎 a 👍 limpia `review_status`. La calificación es editable.
- **`GET /history/review-queue`** (nuevo, superadmin): entradas `feedback='not_useful'
  AND review_status='pending'`, con mensaje del cliente, respuesta generada, fecha,
  plataforma y agente. Incluye `count` para el badge.
- **`POST /history/{id}/correct`** (nuevo, superadmin): body `{corrected_response}`.
  Guarda la corrección, `review_status='corrected'`, asegura embedding.
- **`POST /history/{id}/dismiss`** (nuevo, superadmin): `review_status='dismissed'`
  (👎 que no enseña nada; queda excluida del aprendizaje).
- **`POST /generate`**: la respuesta incluye ahora `history_id` para que el frontend
  pueda calificar la entrada recién creada.

### Inyección de aprendizaje en `/generate`
Después del parseo (reusa el `query_embedding` que ya se calcula para FAQs):

1. Candidatos de la misma plataforma: `feedback='useful'` **o**
   (`feedback='not_useful'` y `corrected_response` no nulo), con embedding presente.
   Límite: los 500 más recientes.
2. Similitud coseno contra el mensaje entrante; se toman **top 3 con similitud ≥ 0.60**.
   Las correcciones se ordenan antes que los 👍 a igualdad (~pesan más).
3. Texto del ejemplo: `generated_response` si fue 👍; `corrected_response` si fue 👎
   corregida.
4. Se inyecta al prompt de Claude una sección: "ejemplos de buenas respuestas a
   interacciones similares — seguí su contenido y estilo cuando aplique".
5. Exclusiones totales: sin calificación, 👎 sin corregir, 👎 descartadas.

**Manejo de errores:** todo el bloque de aprendizaje va en try/except — si falla
(embedding, DB), `/generate` continúa exactamente como hoy, sin ejemplos. Calificar
tampoco puede fallar por el embedding: si el cálculo falla, el feedback se guarda igual
y el embedding queda pendiente (se recalcula al corregir o al próximo intento).

## 3. Frontend

- **Generate.jsx**: botones 👍/👎 junto a la respuesta generada, usando el `history_id`
  devuelto. Estado visual del voto activo; se puede cambiar.
- **History.jsx**: mismos botones por entrada (el API ya devuelve `feedback`).
- **ReviewQueue.jsx** (nueva): lista de 👎 pendientes. Por item: mensaje del cliente,
  respuesta mala, textarea prellenado con la respuesta para editar, botones
  **Guardar corrección** y **Descartar**. Entrada en hamburger menu (Header.jsx) solo
  superadmin, con badge del count.

## 4. Verificación (en servidor, end-to-end)

1. Calificar 👍 una entrada → embedding guardado.
2. Calificar 👎 → aparece en queue; corregirla → sale del queue, queda como ejemplo.
3. Llamar `/generate` con mensaje similar → los ejemplos aparecen en el prompt y la
   respuesta los refleja.
4. Mensaje sin interacciones calificadas similares → flujo idéntico al actual.
5. UI: botones en Generate/History, queue solo visible para superadmin.

## Fuera de alcance

- Notas/reglas de corrección (solo respuesta completa).
- Aprendizaje entre plataformas (los ejemplos son por plataforma).
- Expiración o curación automática de ejemplos aprendidos.
