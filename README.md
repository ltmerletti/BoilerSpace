<div align="center">

<img src="extension/icons/icon128.png" width="72" height="72" alt="BoilerSpace">

# BoilerSpace

**Course answers, right beside Brightspace.**

Understand a lecture. Plan your exam review. Find the clarification you missed.

BoilerSpace brings your Purdue course material, syllabi, deadlines, and Ed and Piazza discussions into one browser side panel. Ask a question, let it look through the material, and follow the citations back to the source.

[**Get started**](#get-started) · [See it in use](#see-it-in-use) · [Changelog](CHANGELOG.md) · [Privacy](PRIVACY.md)

[![CI](https://github.com/ltmerletti/BoilerSpace/actions/workflows/ci.yml/badge.svg)](https://github.com/ltmerletti/BoilerSpace/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/license-GPLv3-blue.svg)](LICENSE)

<img src="docs/images/overview.png" width="1000" alt="BoilerSpace showing a real exam-review conversation beside the course's learning objectives">

*For Purdue students. Works in Chrome, Firefox, and Zen. No separate BoilerSpace account.*

</div>

## See it in use

### Turn an exam scope into a study plan

> What does the syllabus say about the midterm, what does it cover, and what should I review in the course materials?

A syllabus can name a module without spelling out everything you need to study. BoilerSpace opens the relevant lecture files and brings their topics and learning objectives into one cited answer.

In this real conversation, it also found a detail worth checking. The syllabus named Module 1, while a later lecture summary included the first part of Topic 7. The answer called out that difference and linked both sources.

<details>
<summary>See the lecture-by-lecture lookup</summary>

<img src="docs/images/exam-research.png" width="640" alt="Expanded activity from the real midterm question, showing BoilerSpace opening the lecture material for learning objectives">

</details>

### Find the answer buried in a discussion

A project handout may leave an edge case unclear. An instructor's reply several weeks ago may already answer it. Ask searches the saved discussion history, including available replies, and cites the original thread.

- **Ed · Resolve a project edge case.** Two events finish on the same tick. Which gets processed first? BoilerSpace finds the instructor's tie-breaking rule and links the reply.
- **Piazza · Catch a changed deadline.** A later announcement extends two projects again. BoilerSpace finds the newer date and distinguishes it from the earlier extension.

<p>
  <img src="docs/images/ed-clarification.png" width="440" alt="Real Ed-backed answer explaining that simultaneous reviews are processed in increasing official ID order, with a link to the instructor's thread">
  <img src="docs/images/piazza-update.png" width="440" alt="Real Piazza-backed answer identifying May 1 as the revised deadline and citing both the later announcement and the earlier extension">
</p>

### Work through a lecture without losing your place

Keep the lecture open and name the slide, topic, or equation you want to unpack. Ask can read the course file, explain the material, and handle follow-up questions in the same conversation.

> In the Sun–Earth connection lecture, why is Earth's emission temperature lower than its surface temperature? Walk me through the energy balance.

This is an example of a question to try. The screenshots above use actual saved answers, not scripted demo responses. Course labels are renamed for privacy. [About the screenshots](docs/images/README.md)

## Keep the rest of the course in view

- **Week** brings upcoming assignments, quizzes, and exams together, including dates found in syllabi. Export them to your calendar when you need them elsewhere.
- **Courses** keeps current classes, syllabi, and upcoming work close by. Syllabi are checked automatically, including Purdue Simple Syllabus pages.
- **Ask** looks through course files, announcements, syllabi, and connected discussions. Expand its activity to see what it read, or open a citation to inspect the original.

Ed and Piazza are optional. Connect them in Settings using your existing sign-ins. Courses are matched to Brightspace automatically when there is a clear match, and the full available public discussion history is imported, including older posts and replies.

## Get started

You need a Purdue account with access to Brightspace and [Purdue GenAI Studio](https://genai.rcac.purdue.edu). Installation currently uses the source folder. There is no build step, and you do not need Node.js.

**1. Download BoilerSpace.** [Download the source ZIP](https://github.com/ltmerletti/BoilerSpace/archive/refs/heads/main.zip) and extract it. Keep the extracted folder in place.

**2. Load the extension in your browser.**

| Browser | Installation |
| --- | --- |
| **Chrome** | Open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the `extension` folder. |
| **Firefox / Zen** | Open `about:debugging#/runtime/this-firefox`, select **Load Temporary Add-on**, and choose `extension/manifest.json`. Temporary add-ons must be loaded again after quitting the browser. |

**3. Open Brightspace and connect.** Sign into [Purdue Brightspace](https://purdue.brightspace.com), open **BoilerSpace** from its navigation bar or your browser toolbar, and connect Purdue GenAI Studio in **Settings**. Approve the requested site access. Connect Ed or Piazza there if you use them.

Your courses load automatically. Once the material is ready, open **Ask** and start with a course question.

[Setup, updates, and troubleshooting →](docs/USER_GUIDE.md)

## Your data

Course data, conversations, settings, and your GenAI Studio connection are stored in this browser. Answering questions and reading syllabi sends relevant material to **Purdue GenAI Studio** through your account. Grade records and quiz scores are excluded from model inputs.

BoilerSpace has no separate server, account system, or analytics. Ed and Piazza access is read-only. It does not post or reply on your behalf. [Read the privacy details →](PRIVACY.md)

## A few boundaries

BoilerSpace is built for Purdue's Brightspace setup. It reads PDFs, `.pptx`, `.docx`, and HTML when readable content is available. Scanned documents and discussion attachments or images are not currently supported. It stays off active quiz attempt pages.

Answers depend on the available material and the selected GenAI Studio model. Citations make the evidence inspectable; they do not guarantee that every answer is correct. This is an independent project, not an official Purdue or D2L product.

## Help improve BoilerSpace

[Report a bug or suggest an improvement](https://github.com/ltmerletti/BoilerSpace/issues). For development and testing, see [Contributing](CONTRIBUTING.md). Search experiments and evaluation results live in the [technical notes](experiments/discussions/README.md).

[Security](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

BoilerSpace's original code is licensed under [GPL-3.0-only](LICENSE). Copyright © 2026 Luke Merletti. Bundled libraries and fonts retain their own licenses.
