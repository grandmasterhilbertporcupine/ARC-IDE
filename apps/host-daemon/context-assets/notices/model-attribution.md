# Model attribution

The ARC Context asset manifest selects `Xenova/all-MiniLM-L6-v2` at revision `751bff37182d3f1213fa05d7196b954e230abad9`.

The [pinned Xenova model card](https://huggingface.co/Xenova/all-MiniLM-L6-v2/blob/751bff37182d3f1213fa05d7196b954e230abad9/README.md) identifies [sentence-transformers/all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) as its base model and describes the ONNX conversion for Transformers.js. Attribution is retained to those upstream projects and their contributors. The card declares the model's license as Apache-2.0; the complete license text accompanies this notice in `model-apache-2.0.txt`.

The selected upstream model, tokenizer, configuration and card bytes are unchanged. ARC selects the quantized ONNX variant and configures its local runtime separately; it does not modify the pinned model files. The original model card is included in the model asset manifest as `models/Xenova/all-MiniLM-L6-v2/README.md`, preserving its upstream attribution and usage examples. Those examples are documentation, not ARC installation or first-use instructions.

This attribution notice was written for ARC. It is not an upstream NOTICE file and does not change the upstream license. Inclusion does not imply endorsement by the upstream projects or establish retrieval quality, native loading, offline behavior or release acceptance.
