# Bundled discussion model

- Source: https://huggingface.co/minishlab/potion-retrieval-32M
- Revision: `6fc8051fab2a1e0ee76689cf08c853792ac285e7`
- License: MIT, as declared in the unmodified upstream MODEL_CARD.md.
- Source `model.safetensors` SHA-256: `07609e5bd33aad37900b3fd62f4ec96f6daec88ca4d46b9d8b928bfababf6ea0`
- Bundled `model-i8.safetensors` SHA-256: `796f9def7a06baabb842ed18efbce1331f3744a0a77dc5404e82ac8e5f41805e`
- Bundled `tokenizer.json` SHA-256: `7d75cbc54318138807c401b0f0c9721117c628b39de8e8e0edb6cb17e0ee7d18`

BoilerSpace derives the bundled table with `experiments/discussions/quantize-potion.mjs`. Each 512-dimensional row uses a float32 scale of max(abs(row)) / 127 and signed int8 values rounded to the nearest integer, clamped to [-127, 127]. Inference multiplies rows by their scales, removes unknown tokens, pools at most 512 tokens, and L2-normalizes the result. The upstream training-time token weights are already in the table. No course content was used to train or alter these weights.

`LICENSE` is the MIT notice from the upstream Model2Vec project. `MODEL_CARD.md` is copied from the pinned model revision, including its MIT declaration, authorship and training information. This derivative changes numeric storage and adds no restrictions to the MIT model license.
