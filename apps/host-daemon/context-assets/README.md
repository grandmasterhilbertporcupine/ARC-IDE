# Pinned Context asset inputs

These source files describe the model inputs and retain upstream license notices for Phase 5A. They contain no model or native-runtime binaries. Runtime/package staging and the final runtime manifest are separate build outputs. This directory alone does not make Context available or satisfy packaged/offline acceptance.

## Build and package

Use `pnpm exec turbo run build --filter=@bb/host-daemon` for the private runtime, or `pnpm exec turbo run package:windows --filter=@bb/desktop` for the Windows directory package. The `context:assets` prerequisite acquires the seven pinned files only at build time and verifies existing cached bytes before reusing them. The installed worker never downloads missing files.

The runtime is staged at `dist/context/` with its fixed client/worker, local model, curated Windows x64 native dependencies, original package metadata and notices. The manifest records every shipped file's size and digest. Unsupported build targets omit the model/native payload and report unavailable. ONNX installer scripts and their unused dependencies are excluded from the curated runtime.

The acquisition, host build and both bb-app payload-copy tasks are uncached because their output depends on the current platform/architecture and direct Turbo invocations do not establish a target hash. Model files are still reused after verification. The uncached bb-app task reads plugin sources on every build; its inputs intentionally avoid broad plugin/dependency walks. Re-enabling payload caching requires both an enforced target discriminator and complete plugin source dependencies. The cached Electron JavaScript keeps bb-app external; final payload packaging remains uncached.

Run the [packaged Context smoke](../../desktop/scripts/smoke-arc-context.md) against the resulting executable. Development inference, npm file listing, packaged Electron checks, OS-enforced offline execution and clean-machine acceptance are distinct evidence gates.

## Model manifest

`model-manifest.json` has exactly this source contract:

```json
{
  "schemaVersion": 1,
  "model": "Xenova/all-MiniLM-L6-v2",
  "revision": "751bff37182d3f1213fa05d7196b954e230abad9",
  "files": [
    {
      "path": "models/Xenova/all-MiniLM-L6-v2/config.json",
      "bytes": 650,
      "sha256": "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7",
      "url": "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/config.json"
    }
  ]
}
```

The example shows one entry; the actual file has seven. Paths are relative to the staged Context asset root, use forward slashes and include the `models/Xenova/all-MiniLM-L6-v2/` prefix. Each URL names the immutable model revision. URLs are build-time acquisition provenance, not permission to download a model at runtime or on first use.

The seven entries came from actual acquisitions on 2026-09-10 at 19:19:50 UTC, retained locally in `.arc-verification/context-runtime/acquired-model-manifest.json`. That acquisition evidence has SHA-256 `a6ca74cf8344d558819cf0b45d2b57914f94982958c702c479494cb06d7c1437`. Every acquired file was read again on 2026-09-10 and its byte length/SHA-256 independently matched before this source manifest was written. The source manifest SHA-256 is `4a726fe7456189748f45da9cb9c9b8b6f7ad303e22a48ccf22d15195b87047ae`.

| Model-relative file | Bytes | SHA-256 |
| --- | ---: | --- |
| `onnx/model_quantized.onnx` | 22,972,370 | `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1` |
| `config.json` | 650 | `7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7` |
| `tokenizer.json` | 711,661 | `da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0` |
| `tokenizer_config.json` | 366 | `9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3` |
| `special_tokens_map.json` | 125 | `b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3` |
| `vocab.txt` | 231,508 | `07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3` |
| `README.md` | 1,767 | `63ea99bf681a2e9eda4f6a537d5ed8fda95d1677111656da37e9cfd080c3af02` |

Total model inputs: **23,918,447 bytes**. The source of the card/license declaration is the [pinned model tree](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/751bff37182d3f1213fa05d7196b954e230abad9), not a mutable default branch. The pinned card remains one of the acquired inputs; it is not replaced by ARC's attribution notice.

## License acquisition provenance

The following texts were retrieved successfully from the official URLs below on 2026-09-10 at 19:29:25 UTC. HTTP response bytes were written unchanged; the final response URL was identical to the requested URL for each. `.gitattributes` disables line-ending conversion for the verbatim `.txt` notices so a Windows checkout preserves their recorded hashes. Do not format or truncate those files.

| Retained file under `notices/` | Exact official source | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `model-apache-2.0.txt` | [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) | 11,358 | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |
| `transformers-4.2.0-apache-2.0.txt` | [Transformers.js 4.2.0 LICENSE](https://raw.githubusercontent.com/huggingface/transformers.js/4.2.0/LICENSE) | 11,358 | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |
| `onnxruntime-1.24.3-mit.txt` | [ONNX Runtime v1.24.3 LICENSE](https://raw.githubusercontent.com/microsoft/onnxruntime/v1.24.3/LICENSE) | 1,073 | `2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c` |
| `onnxruntime-1.24.3-third-party-notices.txt` | [ONNX Runtime v1.24.3 ThirdPartyNotices.txt](https://raw.githubusercontent.com/microsoft/onnxruntime/v1.24.3/ThirdPartyNotices.txt) | 325,054 | `0e07b95f3a8d6230037707c5c4a2b554d12c4cb67369669ac255635528ffcee2` |

`notices/model-attribution.md` is an ARC-authored attribution record linking the pinned ONNX conversion and its base model. It is distinct from the unchanged upstream license texts. The model's Apache-2.0 declaration comes from its pinned card; the Apache website supplies the corresponding complete license text, not a separate assertion of model ownership.

The stage script must carry these notices, the embedded-component notices below and the actual shipped dependency packages' own licenses/notices into the output. The four texts above are not a complete license inventory for every transitive JavaScript or native package. Preserve ONNX's complete third-party notice even if the first target uses CPU inference.

## Components embedded in the Node distribution

The actual Transformers.js 4.2.0 `dist/transformers.node.mjs` is 1,256,499 bytes with SHA-256 `4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d`. Its distribution annotations identify embedded Tokenizers 0.1.3, Jinja 0.5.6 and ONNX Runtime Web `1.26.0-dev.20260416-b7804b056c`. Those versions describe code already inside the shipped Node file, even though the CPU path uses the separately packaged ONNX Runtime Node 1.24.3. They do not add browser/WASM runtime files to the shipping closure.

`notices/bundled-components.json` retains the distribution digest and annotations, exact package/source identities and notice acquisition records. The following texts were acquired on 2026-09-10 at 19:41:52 UTC and retained without byte changes:

| Retained file under `notices/` | Exact official source | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `jinja-0.5.6-mit.txt` | `package/LICENSE` from the [published Jinja 0.5.6 archive](https://registry.npmjs.org/@huggingface/jinja/-/jinja-0.5.6.tgz) | 1,069 | `d6e7b19451c1b3d1d66353bb4b1274138953b3bfd9ae60c56e77b1f548796982` |
| `tokenizers-0.1.3-apache-2.0.txt` | [Tokenizers LICENSE at its published gitHead](https://raw.githubusercontent.com/huggingface/tokenizers.js/d6fc380d3d4efec25eb1a132bb0cf4f32d618b6c/LICENSE) | 11,357 | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |
| `onnxruntime-web-b7804b056c-mit.txt` | [ONNX Runtime LICENSE at the embedded Web revision](https://raw.githubusercontent.com/microsoft/onnxruntime/b7804b056c30aa35c1748f8e4e239d0e2ff25d6d/LICENSE) | 1,073 | `2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c` |
| `onnxruntime-web-b7804b056c-third-party-notices.txt` | [Complete ONNX notices at the embedded Web revision](https://raw.githubusercontent.com/microsoft/onnxruntime/b7804b056c30aa35c1748f8e4e239d0e2ff25d6d/ThirdPartyNotices.txt) | 325,054 | `0e07b95f3a8d6230037707c5c4a2b554d12c4cb67369669ac255635528ffcee2` |

The Jinja archive was read in memory solely to retain its license and original package metadata; it was not installed or executed. Its 71,561 bytes have SHA-256 `5b94851daebf7b664bb8c15e4da7b6740249de7827dc2adaa43d454704b1708c`, and its SHA-512 matches the exact version's [npm integrity record](https://registry.npmjs.org/%40huggingface%2Fjinja/0.5.6). Its [published provenance](https://registry.npmjs.org/-/npm/v1/attestations/@huggingface%2fjinja@0.5.6) reports source commit `f9f7b300148c47cae88b119f62ec8ad94636a137`, where the source package still declares 0.5.5. The retained archive metadata declares 0.5.6, matching the embedded annotation. The license therefore comes from that exact archive; the later locally resolved Jinja 0.5.10 package is not used as its provenance.

Tokenizers 0.1.3's [npm metadata](https://registry.npmjs.org/%40huggingface%2Ftokenizers/0.1.3) identifies gitHead `d6fc380d3d4efec25eb1a132bb0cf4f32d618b6c`; that commit's package metadata also declares 0.1.3. The embedded ONNX Web suffix resolves to full commit `b7804b056c30aa35c1748f8e4e239d0e2ff25d6d`. Its license and complete third-party notice happen to match the retained Node 1.24.3 notice bytes, but each acquisition is recorded against its own source revision. The complete upstream notice includes components beyond this CPU payload and is preserved without claiming that each listed component is packaged.

## Current dependency and acceptance limits

The local investigation uses Transformers.js 4.2.0 and ONNX Runtime Node 1.24.3. Its Sharp override is **0.35.4**: the prior 0.35.3 candidate was still affected by the newer [maintainer libheif advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c). This records the investigation's correction, not a blanket safety claim for a package version or closure.

The retained second audit still reports moderate findings through adm-zip, including 0.6.0, associated with [destination-symlink extraction](https://github.com/advisories/GHSA-vwc7-r8mq-g2x9). The shipping closure must explicitly exclude unused installer dependencies with verified reachability, or otherwise resolve the finding. License collection does not waive dependency findings. The detailed local audit and loading evidence remain in `.arc-verification/context-runtime/README.md` and its adjacent reports.

Build-time source hashes and library-local loading controls do not establish a signed package, OS-level network denial, clean-machine loading, queue/cancellation behavior, resource bounds, retrieval quality or coverage. Those remain separate implementation and acceptance gates. No runtime download fallback is authorized by this manifest.
