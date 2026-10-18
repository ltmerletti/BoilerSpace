# Third-party notices

BoilerSpace's original code is licensed under GPLv3 only. The following bundled components retain their own copyright notices and licenses; the root license does not replace them.

| Component | Bundled location | License and notice |
| --- | --- | --- |
| [PDF.js](https://github.com/mozilla/pdf.js), bundled version 5.4.296 | `extension/vendor/pdfjs/` | [Apache License 2.0](extension/vendor/pdfjs/LICENSE); Mozilla Foundation and contributors |
| OpenJPEG and QCMS codecs distributed with PDF.js 5.4.296 | `extension/vendor/pdfjs/wasm/` | Upstream [OpenJPEG](extension/vendor/pdfjs/wasm/LICENSE_OPENJPEG), [QCMS](extension/vendor/pdfjs/wasm/LICENSE_QCMS) and PDF.js wrapper [OpenJPEG](extension/vendor/pdfjs/wasm/LICENSE_PDFJS_OPENJPEG) / [QCMS](extension/vendor/pdfjs/wasm/LICENSE_PDFJS_QCMS) notices |
| Adobe character maps used by PDF.js | `extension/vendor/pdfjs/cmaps/` | [Adobe redistribution notice](extension/vendor/pdfjs/cmaps/LICENSE), including its conditions and disclaimer |
| Foxit/PDFium standard font data | `extension/vendor/pdfjs/standard_fonts/` | [BSD-style redistribution notice](extension/vendor/pdfjs/standard_fonts/LICENSE_FOXIT) |
| Liberation font data | `extension/vendor/pdfjs/standard_fonts/` | [SIL Open Font License 1.1 and copyright notices](extension/vendor/pdfjs/standard_fonts/LICENSE_LIBERATION) |
| [LinkeDOM](https://github.com/WebReflection/linkedom), version 0.18.13 | `extension/vendor/linkedom/` | [ISC License](extension/vendor/linkedom/LICENSE), copyright Andrea Giammarchi; bundled worker includes its upstream parser dependencies, whose notices are retained in [NOTICE.md](extension/vendor/linkedom/NOTICE.md) |
| [fflate](https://github.com/101arrowz/fflate/tree/v0.8.2), version 0.8.2 | `extension/vendor/fflate/` | [MIT License](extension/vendor/fflate/LICENSE), copyright Arjun Barrett |
| [Lato](https://www.latofonts.com/) | `extension/fonts/` | [SIL Open Font License 1.1](extension/fonts/OFL.txt), copyright tyPoland Łukasz Dziedzic, with Reserved Font Name “Lato” |
| [Tokenizers.js](https://github.com/huggingface/tokenizers.js), version 0.2.0 | `extension/vendor/tokenizers/` | [Apache License 2.0](extension/vendor/tokenizers/LICENSE); Hugging Face and contributors |
| [POTION retrieval 32M](https://huggingface.co/minishlab/potion-retrieval-32M), revision `6fc8051fab2a1e0ee76689cf08c853792ac285e7` | `extension/vendor/potion/` | MIT per the bundled [upstream model card](extension/vendor/potion/MODEL_CARD.md); includes the [Model2Vec MIT notice](extension/vendor/potion/LICENSE), copyright Thomas van Dongen. BoilerSpace converts the published float32 table to row-wise symmetric int8. |

Keep the bundled license files and source notices when redistributing the extension or updating a dependency. Update this table when the bundled components change.

### Exact upstream distributions

The executable libraries below are unmodified files from their official npm release archives. The release audit verified their SHA-256 hashes against those distributions; they can be retrieved without executing installation scripts.

| Bundled file | Official release archive and path | SHA-256 |
| --- | --- | --- |
| `vendor/pdfjs/pdf.min.mjs` | [pdfjs-dist 5.4.296](https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-5.4.296.tgz), `package/build/pdf.min.mjs` | `343b4166b06716a55a8f87175b83223cb1a9ab701eb8a96b2577509d47fbaf4a` |
| `vendor/pdfjs/pdf.worker.min.mjs` | Same archive, `package/build/pdf.worker.min.mjs` | `dbcae78a691b3c501508f74b774c6066a57a14a76cefdc9e25ad86b651bb75d5` |
| `vendor/pdfjs/wasm/openjpeg.wasm` | Same archive, `package/wasm/openjpeg.wasm` | `67b8e2b162da472e98cb48d3d32e3e38fff481b9b32ff4818e78bb248af88ab2` |
| `vendor/pdfjs/wasm/openjpeg_nowasm_fallback.js` | Same archive, `package/wasm/openjpeg_nowasm_fallback.js` | `07c3c3361827308741bc31c561b59e705ebb4d1e8efb84e4d24884e230dbb894` |
| `vendor/pdfjs/wasm/qcms_bg.wasm` | Same archive, `package/wasm/qcms_bg.wasm` | `6017eca5939cde1836e88e6d8cd27ae039246f206515ea4487bdfd0e3fb16e26` |
| `vendor/fflate/fflate.js` | [fflate 0.8.2](https://registry.npmjs.org/fflate/-/fflate-0.8.2.tgz), `package/esm/browser.js` | `8cc1f687e0159e977addb6b85e274dbd11e622cf151f4fcb7b85d49622ea43e7` |
| `vendor/tokenizers/tokenizers.mjs` | [@huggingface/tokenizers 0.2.0](https://registry.npmjs.org/@huggingface/tokenizers/-/tokenizers-0.2.0.tgz), `package/dist/tokenizers.mjs` | `1c4a848f86156201c033d6cd08c4cf81ae1088552acec3367f31ef086edf5af0` |
| `vendor/linkedom/worker.js` | [linkedom 0.18.13](https://registry.npmjs.org/linkedom/-/linkedom-0.18.13.tgz), `package/worker.js` | `ea9f1de69b009d210968dd8f4d3f4ecf1095bedf80d389ec83244c1713578288` |

Readable upstream source: [PDF.js v5.4.296](https://github.com/mozilla/pdf.js/tree/v5.4.296), [fflate v0.8.2](https://github.com/101arrowz/fflate/tree/v0.8.2), [Tokenizers.js v0.2.0](https://github.com/huggingface/tokenizers.js/tree/v0.2.0), and [LinkeDOM v0.18.13](https://github.com/WebReflection/linkedom/tree/v0.18.13). PDF.js's npm archive also includes unminified `build/pdf.mjs` and `build/pdf.worker.mjs`. LinkeDOM and Tokenizers.js are bundled in readable form. See the model's provenance for its separate numeric-table conversion.

## Development fixtures

The API tests use fixtures from [David Chen's Brightspace Bar](https://github.com/DavidChen-006/Brightspace-Bar), an MIT-licensed project. The fixture checkout is separate from this repository and is not bundled in the extension. See [Contributing](CONTRIBUTING.md#unit-tests) for the pinned setup and retain the upstream license if redistributing those fixtures.

## Course content and service names

Course documents and third-party website content remain the property of their respective owners. The project license does not license that material or grant rights to Purdue, Brightspace, D2L, Simple Syllabus, or GenAI Studio names and marks. Their appearance identifies the services the extension works with and does not imply endorsement.
