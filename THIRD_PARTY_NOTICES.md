# Third-party notices

BoilerSpace's original code is licensed under GPLv3 only. The following bundled components retain their own copyright notices and licenses; the root license does not replace them.

| Component | Bundled location | License and notice |
| --- | --- | --- |
| [PDF.js](https://github.com/mozilla/pdf.js), bundled version 5.4.296 | `extension/vendor/pdfjs/` | [Apache License 2.0](extension/vendor/pdfjs/LICENSE); Mozilla Foundation and contributors |
| Adobe character maps used by PDF.js | `extension/vendor/pdfjs/cmaps/` | [Adobe redistribution notice](extension/vendor/pdfjs/cmaps/LICENSE), including its conditions and disclaimer |
| Foxit/PDFium standard font data | `extension/vendor/pdfjs/standard_fonts/` | [BSD-style redistribution notice](extension/vendor/pdfjs/standard_fonts/LICENSE_FOXIT) |
| Liberation font data | `extension/vendor/pdfjs/standard_fonts/` | [SIL Open Font License 1.1 and copyright notices](extension/vendor/pdfjs/standard_fonts/LICENSE_LIBERATION) |
| [fflate](https://github.com/101arrowz/fflate) | `extension/vendor/fflate/` | [MIT License](extension/vendor/fflate/LICENSE), copyright Arjun Barrett |
| [Lato](https://www.latofonts.com/) | `extension/fonts/` | [SIL Open Font License 1.1](extension/fonts/OFL.txt), copyright tyPoland Łukasz Dziedzic, with Reserved Font Name “Lato” |

Keep the bundled license files and source notices when redistributing the extension or updating a dependency. Update this table when the bundled components change.

## Development fixtures

The API tests use fixtures from [David Chen's Brightspace Bar](https://github.com/DavidChen-006/Brightspace-Bar), an MIT-licensed project. The fixture checkout is separate from this repository and is not bundled in the extension. See [Contributing](CONTRIBUTING.md#unit-tests) for the pinned setup and retain the upstream license if redistributing those fixtures.

## Course content and service names

Course documents and third-party website content remain the property of their respective owners. The project license does not license that material or grant rights to Purdue, Brightspace, D2L, Simple Syllabus, or GenAI Studio names and marks. Their appearance identifies the services the extension works with and does not imply endorsement.
