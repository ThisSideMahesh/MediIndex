# MediIndex - Project-II Gap Audit and Next Actions

**Baseline reviewed:** `B.Tech-Group-02_Major_Project_Report_WithoutConclusion.pdf` (58 PDF pages; report pages 1-47)  
**Assessment date:** 24 August 2026  
**Evidence standard:** a feature is not complete until code, integration, an executed test, and retained evidence exist.

## Bottom line

The submitted baseline is a **Project-I proposed-system report**. It is not evidence that MediIndex has been implemented. It describes an ambitious product, but no source repository, build, database file, API collection, test results, screenshots of a running application, prediction dataset, or deployment evidence was provided. Therefore the truthful Project-II starting status is:

| Area | Status |
|---|---|
| Problem definition, objectives, scope and proposed design | **COMPLETED / documented** |
| Architecture and database design | **PROPOSED / needs implementation verification** |
| All product modules | **NOT PROVIDED / NEEDS VERIFICATION** |
| Test and validation evidence | **NOT PROVIDED** |
| Demand-prediction accuracy | **NOT PROVIDED - do not claim accuracy** |
| Cloud synchronization and inter-pharmacy network | **NOT PROVIDED - do not claim implemented** |
| Final report conclusion | **MISSING by design in supplied filename/report** |

## What the Project-I report actually establishes

### Approved problem and target

MediIndex targets independent Indian medical stores with batch-level inventory, expiry monitoring, billing-linked stock reduction, QR-assisted stock entry, analytics, demand prediction, offline operation, and role-based access. It states that the desktop client is primary; mobile is limited to scanning/stock entry.

### Objectives carried into Project-II

1. Track medicine stock, batches and expiry dates.
2. Generate configurable expiry alerts.
3. Use a smartphone QR scanner for stock entry.
4. Link billing/sales to stock deduction.
5. Forecast demand from up to six months of sales data.
6. Provide inventory, sales, expiry and low-stock analytics.
7. Locate medicine using a 2D shelf map.
8. Check/request availability across connected pharmacies.
9. Work offline first, with selective cloud synchronization.
10. Enforce authentication and admin/staff authorization.

### Proposed, not verified, architecture

React + Electron desktop UI; Node.js + Express business/API layer; SQLite local store; smartphone QR client over local Wi-Fi; Firebase Firestore **or** PostgreSQL for cloud; Chart.js/Recharts; JWT + bcrypt. The report also proposes weighted moving average plus a seasonal adjustment for 30-day restocking recommendations and FIFO batch dispensing.

## P0: scope correction before coding

The present scope is too large for a credible final-year implementation if the team starts without a working codebase. A desktop client, local REST service, mobile scanner, offline sync engine, cloud sync, inter-pharmacy network, billing, RBAC, mapping, analytics and forecasting are not one feature set; they are several products.

Freeze the Project-II demo scope as follows:

| Priority | Commit for final demo | Evidence required |
|---|---|---|
| P0 | Login/RBAC, medicines, batch inventory, expiry/low-stock alerts, billing, FEFO/FIFO stock deduction, SQLite persistence | working build, seeded database, test cases, screenshots/video |
| P1 | Dashboard analytics and simple weighted-moving-average forecast | repeatable sample dataset; forecast calculation; MAE/MAE alternative defined and measured if holdout data exists |
| P1 | QR stock entry | end-to-end scan/parse/confirm/save on actual device or an honest, working desktop substitute |
| P2 | 2D shelf locator | simple map with stored shelf locations |
| Defer unless already working | cloud synchronization and inter-pharmacy stock network | two working installations, reconciliation/conflict behaviour, network-failure test |

**Hard recommendation:** choose one cloud design, or defer cloud entirely. The baseline treats Firestore and PostgreSQL as interchangeable alternatives; they are not. Mixing a local relational database with two unspecified cloud options creates needless work and makes data synchronization impossible to defend. For a constrained Project-II, demonstrate offline-first SQLite locally and label cloud/inter-pharmacy as **planned** unless the full sync path is already working and tested.

## Baseline-to-Project-II module register

| Module | Baseline claim | Evidence supplied | Truthful current status | Project-II acceptance test |
|---|---|---|---|---|
| Inventory and batches | Proposed | Design/schema only | NEEDS VERIFICATION | Create/edit medicine; receive multiple batches; persist after restart |
| Expiry and low-stock alerts | Proposed | Threshold design only | NEEDS VERIFICATION | Seed near-expiry/expired/low-stock records; assert alert severity and no duplicate false alerts |
| Billing and stock deduction | Proposed | FIFO narrative only | NEEDS VERIFICATION | Sale with multiple batches deducts correct eligible batch atomically; insufficient stock fails safely |
| QR stock entry | Proposed | QR parsing narrative only | NEEDS VERIFICATION | Scan valid code, review values, create/update correct batch; invalid payload rejected |
| Analytics | Proposed | Chart list only | NEEDS VERIFICATION | Dashboard totals reconcile exactly with database queries |
| Demand prediction | Proposed | Formula narrative only | NEEDS VERIFICATION | Reproducible forecast from fixed historical data; report error only from actual held-out data |
| Shelf locator | Proposed | Module narrative only | NEEDS VERIFICATION | Save shelf location and find medicine in UI |
| Inter-pharmacy availability | Proposed | Architecture narrative only | NEEDS VERIFICATION | Only claim after two participants, permissions, stale-data handling, and network tests |
| Offline/cloud sync | Proposed | Architecture narrative only | NEEDS VERIFICATION | Run offline, queue/change local data, reconnect, reconcile and retain an audit log |
| Authentication/RBAC | Proposed | JWT/bcrypt design only | NEEDS VERIFICATION | Wrong password rejected; admin-only route blocked for staff; password stored as bcrypt hash |

## Report defects that must be fixed before final submission

1. The report repeatedly switches between **proposed/future** tense and **developed** tense. In Project-II, every implementation claim must be backed by evidence; otherwise write “proposed” or “not implemented.”
2. The supplied report has no conclusion; a final report must include a conclusion and future scope, as required by the institute’s chapter structure.
3. The module numbering is inconsistent in the functional module table: M05/M06 are shifted compared with the preceding module listing. Standardize one numbering scheme everywhere.
4. The cloud architecture is undecided: “Firebase Firestore / PostgreSQL” and “Firebase REST API” are presented together without a single data model, sync protocol, conflict rule, or authentication boundary.
5. The database specification is incomplete/inconsistent. It mentions entities such as Customer and Store Layout, but they are not fully specified in the shown table set. The User/Staff table content appears after its caption. Resolve foreign keys, constraints, inventory transaction strategy, and indexing from the actual database implementation.
6. “FIFO” conflicts with the described rule “nearest expiry first.” Nearest-expiry dispensing is FEFO, not FIFO. Pick the real rule, use it consistently, and test it.
7. QR payload expectations are unrealistic unless the team controls the QR labels: ordinary medicine barcodes/QR codes will not reliably contain batch, manufacturing date, and expiry date. Define the supported standard/payload and the manual correction path.
8. The reported survey figures and listed references need source records and independent verification before reuse. No raw response export, consent/collection record, DOI, or source link was supplied. Until verified, mark all such evidence **NEEDS VERIFICATION**.
9. The report describes a mobile app yet states mobile UI implementation is not included. The Project-II report must state exactly what was implemented.
10. The institute asks for at least 10 research-paper references and plagiarism below 10%. The baseline lists 11 references, but their bibliographic validity has not been verified in the supplied material.

## Source-of-truth files to create in the implementation repository

Create these before parallel work begins. They prevent different tools or teammates from inventing different systems.

| File | Minimum contents |
|---|---|
| `PROJECT_STATE.md` | stage, evidence links, completed/in-progress/blocked items, next action |
| `ARCHITECTURE.md` | frozen stack, component boundaries, trust boundaries, decisions |
| `DATABASE_SCHEMA.md` | actual migrations/DDL, ER diagram, constraints, indexes, sample data rules |
| `API_SPEC.md` | endpoint contract, authentication, errors, QR payload contract |
| `MODULE_STATUS.md` | one row per module with implemented/verified status and evidence |
| `TEST_RESULTS.md` | test ID, data set, expected/actual result, date, evidence |
| `SECURITY_REVIEW.md` | password storage, RBAC, input validation, local-data protection, threat notes |
| `RESEARCH_SOURCES.md` | verified citation metadata and which claim each source supports |
| `DECISIONS.md` | dated architecture/scope decisions and rejected alternatives |
| `TODO.md` | ordered, owned work items and blockers |

## First 10 working actions

1. Provide the actual code repository or state plainly that none exists.
2. Freeze the P0 scope and decide whether cloud/inter-pharmacy is deferred.
3. Choose **one** desktop architecture and package manager; do not begin implementation with both an Electron backend and a separate arbitrary server unless the boundary is necessary.
4. Write and run SQLite migrations for medicines, batches/inventory, users, sales/sale-items, suppliers and alerts. Use a sale header plus sale lines; the baseline’s single `Sales` table is insufficient for multi-item bills.
5. Seed deterministic test data including expired, near-expiry, low-stock and multi-batch medicines.
6. Implement and test login/RBAC, inventory and batch receipt.
7. Implement billing as a transaction with the real dispensing rule (prefer FEFO for expiring stock), then test rollback on failure.
8. Implement alerts and dashboard calculations directly from the database.
9. Implement prediction only after sales data exists. Use a fixed holdout period and report MAE only if it was actually calculated.
10. Capture evidence continuously: build version, screenshots, test output, test data provenance, and known limitations.

## Submission and report checklist

Follow the supplied institute guideline: A4, Times New Roman, chapter headings 14 pt bold uppercase, text 12 pt, 1.5 line spacing, captions below figures, table titles above tables, and page numbers bottom centre. Required report structure includes title page, certificate, acknowledgement, abstract, introduction, literature review, methodology, results/discussion, conclusion/future scope, references and appendices.

For Project-II, add only evidence that the team can demonstrate:

- Screenshots labeled with actual build/version and date.
- ER/DFD/architecture diagrams revised to match actual code.
- A test matrix covering normal, invalid, boundary and offline cases.
- Dataset description and forecast evaluation procedure.
- Real limitations: no supplier integration, controlled-drug compliance, limited data, untested cloud features, and any deferred modules.
- Team contribution table marked **NEEDS VERIFICATION** until real ownership is supplied.

## Current project state

| Field | Current value |
|---|---|
| Current stage | Project-II revalidation and implementation planning |
| Completed | Project-I problem/design report supplied |
| In progress | Evidence audit and scope freeze |
| Blocked | No implementation repository or execution evidence supplied |
| Critical risk | Treating a proposed Project-I architecture as completed software |
| Next required input | Repository, current build/run instructions, database/migrations, and any test or demo evidence |

