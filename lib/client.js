window.__ModuleLoader__.load({
	id: "dsh-session-log-universal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region UploadPreference
		/** Ordered preference writes and notices that survive the settings panel. */
		/** Writes the Host setting without publishing an optimistic upload state. */
		var UploadPreference = class {
			form;
			/** Observable mutation outcome. */
			state = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
				busy: false,
				notice: null,
				sequence: 0
			});
			/** @param form - Host-owned configuration form. */
			constructor(form) {
				this.form = form;
			}
			/**
			* Persist enablement; refusal or transport failure leaves the accepted value visible.
			* @param enabled - requested upload state.
			* @returns completion after the write settles.
			*/
			async setEnabled(enabled) {
				if (this.state.getSnapshot().busy) return;
				this.state.update((state) => {
					state.busy = true;
					state.notice = null;
				});
				let accepted = false;
				try {
					accepted = await this.form.set("enabled", enabled);
				} catch (_error) {}
				this.state.update((state) => {
					state.busy = false;
					state.notice = accepted ? "saved" : "failed";
					state.sequence++;
				});
			}
			/** Clear the displayed mutation notice. */
			dismiss() {
				this.state.update((state) => {
					state.notice = null;
				});
			}
		};
		//#endregion
		//#region UploadRow.module.css
		const css = ".YXcioW_row{border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;align-items:center;gap:24px;padding:16px 0;display:flex}.YXcioW_title{font-size:14px;line-height:20px}.YXcioW_description{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px}";
		const tagId = "dsh-session-log-universal/UploadRow.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-session-log-universal";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var UploadRow_module_css_default = {
			"description": "YXcioW_description",
			"row": "YXcioW_row",
			"title": "YXcioW_title"
		};
		//#endregion
		//#region UploadRow
		/** General settings row and persistent shell notice for universal log uploads. */
		/**
		* Render the accepted upload state.
		* @param props - settings hooks, writer and localized copy.
		* @returns the preference row shown under the official one.
		*/
		function UploadRow({ useUpload, useMutation, setEnabled, t }) {
			const upload = useUpload((value) => value);
			const busy = useMutation((value) => value.busy);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: UploadRow_module_css_default.row,
				children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("div", {
					className: UploadRow_module_css_default.title,
					children: t("title")
				}), (0, react_jsx_runtime.jsx)("div", {
					className: UploadRow_module_css_default.description,
					children: t("description")
				})] }), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
					checked: upload.value?.enabled === true,
					label: t("title"),
					disabled: busy || upload.status !== "ready" || !upload.writable,
					onChange: (enabled) => {
						setEnabled(enabled);
					}
				})]
			});
		}
		/**
		* Keep the save outcome visible after settings closes.
		* @param props - mutation hook, dismissal and localized copy.
		* @returns the current toast, or nothing.
		*/
		function UploadToast({ useMutation, dismiss, t }) {
			const state = useMutation((value) => value);
			if (state.notice === null) return null;
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Toast, {
				text: t(state.notice),
				onDone: dismiss,
				...state.notice === "saved" ? { tone: "success" } : {}
			}, state.sequence);
		}
		//#endregion
		//#region UploadStatus.module.css
		const uploadStatusCss = ".sluUs_section{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}.sluUs_metaRow{align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;display:flex}.sluUs_stats{flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none;display:flex}.sluUs_stat{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill);flex-direction:column;gap:2px;min-width:88px;padding:8px 12px;display:flex}.sluUs_statLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}.sluUs_statValue{font-size:16px;font-weight:600;line-height:22px;font-variant-numeric:tabular-nums}.sluUs_refresh{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;flex:none;padding:4px 10px;font:inherit;font-size:13px;line-height:20px}.sluUs_refresh:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.sluUs_refresh:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}.sluUs_refresh:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}.sluUs_meta{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}.sluUs_search{display:block}.sluUs_search input{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);width:100%;height:34px;color:var(--dsw-alias-label-primary);outline:none;padding:0 12px;font:inherit;font-size:13px}.sluUs_search input::placeholder{color:var(--dsw-alias-label-tertiary)}.sluUs_search input:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)) 18%,transparent)}.sluUs_list{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill);flex-direction:column;max-height:min(56vh,480px);margin:0;padding:0;list-style:none;display:flex;overflow:auto}.sluUs_row{border-bottom:.5px solid var(--dsw-alias-border-l2);grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:4px 16px;padding:10px 14px;display:grid}.sluUs_row:last-child{border-bottom:0}.sluUs_rowMain{min-width:0}.sluUs_rowTitle{font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sluUs_rowPath{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code)}.sluUs_rowFacts{margin-top:4px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap;gap:10px;font-size:12px;line-height:18px;display:flex;font-variant-numeric:tabular-nums}.sluUs_rowSide{flex-direction:column;align-items:flex-end;gap:4px;display:flex;text-align:right}.sluUs_badge{white-space:nowrap;border-radius:var(--dsw-radius-xs);align-items:center;padding:0 8px;font-size:12px;line-height:18px;display:inline-flex}.sluUs_badge[data-state=uploaded]{color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 68%,var(--dsw-alias-label-secondary));background:var(--dsw-alias-state-success-tertiary)}.sluUs_badge[data-state=partial],.sluUs_badge[data-state=never]{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l3)}.sluUs_ack{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}.sluUs_note{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}.sluUs_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:13px;line-height:20px}.sluUs_banner{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary);border-radius:var(--dsw-radius-sm);margin:0;padding:6px 10px;font-size:12px;line-height:18px}.sluUs_tools{align-items:center;gap:8px;flex:none;flex-wrap:nowrap;display:flex}.sluUs_caps{color:var(--dsw-alias-label-tertiary);white-space:nowrap;flex:none;font-size:12px;line-height:18px}.sluUs_backfill{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;flex:none;padding:4px 10px;font:inherit;font-size:13px;line-height:20px}.sluUs_backfill:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.sluUs_backfill:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}.sluUs_backfill:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}.sluUs_statInteractive{display:flex}.sluUs_statButton{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill);flex-direction:column;gap:2px;min-width:88px;color:inherit;text-align:left;cursor:pointer;padding:8px 12px;font:inherit;display:flex}.sluUs_statButton:hover{background:var(--dsw-alias-bg-layer-2)}.sluUs_statButton[data-active=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary);box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary)}.sluUs_statButton[data-active=true] .sluUs_statLabel{color:var(--dsw-alias-label-primary)}.sluUs_statButton[data-tone=uploaded] .sluUs_statValue{color:var(--dsw-alias-state-success-primary)}.sluUs_statButton:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}.sluUs_pager{align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;display:flex}.sluUs_pagerCount{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}.sluUs_pagerTools{align-items:center;gap:8px;flex-wrap:nowrap;display:flex}.sluUs_pagerSize{align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;display:flex}.sluUs_pagerSize select{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);height:28px;color:var(--dsw-alias-label-primary);padding:0 6px;font:inherit;font-size:12px}.sluUs_pagerButton{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;padding:3px 10px;font:inherit;font-size:12px;line-height:18px}.sluUs_pagerButton:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.sluUs_pagerButton:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}.sluUs_pagerPage{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}";
		const uploadStatusTagId = "dsh-session-log-universal/UploadStatus.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(uploadStatusTagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-session-log-universal";
			tag.dataset.pluginCss = uploadStatusTagId;
			tag.textContent = uploadStatusCss;
			document.head.appendChild(tag);
		}
		var UploadStatus_module_css_default = {
			"ack": "sluUs_ack",
			"backfill": "sluUs_backfill",
			"caps": "sluUs_caps",
			"pager": "sluUs_pager",
			"pagerButton": "sluUs_pagerButton",
			"pagerCount": "sluUs_pagerCount",
			"pagerPage": "sluUs_pagerPage",
			"pagerSize": "sluUs_pagerSize",
			"pagerTools": "sluUs_pagerTools",
			"statButton": "sluUs_statButton",
			"statInteractive": "sluUs_statInteractive",
			"tools": "sluUs_tools",
			"banner": "sluUs_banner",
			"badge": "sluUs_badge",
			"error": "sluUs_error",
			"list": "sluUs_list",
			"meta": "sluUs_meta",
			"note": "sluUs_note",
			"refresh": "sluUs_refresh",
			"row": "sluUs_row",
			"rowFacts": "sluUs_rowFacts",
			"rowMain": "sluUs_rowMain",
			"rowPath": "sluUs_rowPath",
			"rowSide": "sluUs_rowSide",
			"rowTitle": "sluUs_rowTitle",
			"search": "sluUs_search",
			"section": "sluUs_section",
			"stat": "sluUs_stat",
			"statLabel": "sluUs_statLabel",
			"stats": "sluUs_stats",
			"statValue": "sluUs_statValue",
			"metaRow": "sluUs_metaRow"
		};
		//#endregion
		//#region UploadStatusReport
		/** Read-only Host route carrying the upload snapshot. */
		const STATUS_REPORT_ROUTE = "/plugin/session-log-universal/report";
		/** The same route in document-relative form, the only form the desktop transport accepts. */
		const STATUS_REPORT_PATH = STATUS_REPORT_ROUTE.slice(1);
		/** Host route that starts a catch-up upload of everything not sent yet. */
		const STATUS_BACKFILL_ROUTE = "/plugin/session-log-universal/backfill";
		/** The same route in document-relative form. */
		const STATUS_BACKFILL_PATH = STATUS_BACKFILL_ROUTE.slice(1);
		/** Declared states that mean every stored event reached the collector. */
		const STATUS_UPLOADED_WORDS = [
			"uploaded",
			"upload",
			"acked",
			"acknowledged",
			"confirmed",
			"complete",
			"completed",
			"done",
			"success",
			"succeeded",
			"ok"
		];
		/** Declared states that mean the collection stopped part way. */
		const STATUS_PARTIAL_WORDS = [
			"partial",
			"partialupload",
			"partiallyuploaded",
			"incomplete"
		];
		/** Declared states that mean nothing reached the collector. */
		const STATUS_NEVER_WORDS = [
			"never",
			"pending",
			"queued",
			"waiting",
			"idle",
			"notuploaded",
			"unuploaded",
			"skipped",
			"new",
			"none"
		];
		/** Read a plain record, or nothing for arrays and primitives. */
		function statusRecord(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
		}
		/** First finite number among the candidates. */
		function statusNumber(...candidates) {
			for (const value of candidates) {
				if (typeof value === "number" && Number.isFinite(value)) return value;
				if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
			}
		}
		/** First non-empty text among the candidates. */
		function statusText(...candidates) {
			for (const value of candidates) {
				if (typeof value === "string" && value.trim() !== "") return value.trim();
				if (typeof value === "number" && Number.isFinite(value)) return String(value);
			}
		}
		/** First instant among the candidates, normalized to epoch milliseconds. */
		function statusTime(...candidates) {
			const absolute = candidates.map((value) => statusNumber(value)).find((value) => value !== void 0 && value > 0);
			if (absolute !== void 0) return absolute < 1e12 ? absolute * 1000 : absolute;
			for (const value of candidates) {
				if (typeof value !== "string" || value.trim() === "") continue;
				const parsed = Date.parse(value);
				if (Number.isFinite(parsed)) return parsed;
			}
		}
		/**
		* Read the report route once, through whichever transport this host exposes.
		* @returns the decoded payload record.
		* @throws when no transport answers, the route refuses, or the body is not a record.
		*/
		async function readStatusRoute() {
			const transport = globalThis.__DSH_TRANSPORT__?.fetch ?? globalThis.fetch?.bind(globalThis);
			if (typeof transport !== "function") throw new Error("no fetch transport");
			const response = await transport(STATUS_REPORT_PATH, {
				method: "GET",
				headers: { accept: "application/json" },
				cache: "no-store"
			});
			if (response?.ok !== true) throw new Error(`HTTP ${response?.status ?? "?"} ${STATUS_REPORT_ROUTE}`);
			const payload = statusRecord(await response.json());
			if (payload === void 0) throw new Error("response is not a JSON object");
			return payload;
		}
			/**
			* Ask the Host to upload what the local logs have not sent yet.
			* @param request - caps for the run, null meaning the Host default.
			* @returns the Host answer, classified for the panel.
			*/
			async function requestBackfill(request) {
				const transport = globalThis.__DSH_TRANSPORT__?.fetch ?? globalThis.fetch?.bind(globalThis);
				if (typeof transport !== "function") return { kind: "failed", status: 0, detail: "no fetch transport" };
				let response;
				try {
					response = await transport(STATUS_BACKFILL_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(request)
					});
				} catch (error) {
					return { kind: "failed", status: 0, detail: error instanceof Error ? error.message : String(error) };
				}
				if (response?.ok === true) return { kind: "started" };
				const status = typeof response?.status === "number" ? response.status : 0;
				if (status === 409) return { kind: "busy" };
				let detail;
				try {
					const body = statusRecord(await response.json());
					detail = statusText(body?.error, body?.message);
				} catch (_unreadable) {}
				if (status === 400) return { kind: "invalid", detail: detail ?? "Bad Request" };
				return { kind: "failed", status, detail };
			}
		/**
		* Resolve the badge state. The Host decides how to read partial progress, because only
		* it can compare a file update time with the last confirmation; this fallback runs only
		* when the payload carries no state at all.
		* @param declared - Host state text, when the row carries one.
		* @param ackedSeq - highest acknowledged sequence, or null when nothing was acknowledged.
		* @returns the badge state.
		*/
		function statusState(declared, ackedSeq) {
			const word = typeof declared === "string" ? declared.toLowerCase().replace(/[^a-z]/g, "") : "";
			if (STATUS_PARTIAL_WORDS.includes(word)) return "partial";
			if (STATUS_UPLOADED_WORDS.includes(word)) return "uploaded";
			if (STATUS_NEVER_WORDS.includes(word)) return "never";
			return typeof ackedSeq === "number" && Number.isFinite(ackedSeq) ? "uploaded" : "never";
		}
		/**
		* Fold one Host row record into the row this page renders.
		* @param entry - Host row record.
		* @param index - position, used for a stable key when the session id is missing.
		* @returns the display row.
		*/
		function statusRow(entry, index) {
			const row = statusRecord(entry) ?? {};
			const upstream = statusRecord(row.upstream);
			const sessionId = statusText(row.sessionId, row.id) ?? "";
			// A null count is unknown, not zero: the JSONL backend cannot count historical events.
			const localEvents = statusNumber(row.localEvents, row.eventCount, row.events) ?? null;
			// The highest local sequence is one less than the count, and unknown alongside it.
			const localSeq = statusNumber(row.localSeq, row.lastSeq) ?? (localEvents === null ? null : localEvents - 1);
			// null is a fact, not a zero: no upstream acknowledgement has ever arrived.
			const ackedSeq = statusNumber(row.ackedSeq, row.uploadedSeq) ?? null;
			return {
				key: sessionId === "" ? `row-${index}` : sessionId,
				sessionId,
				title: statusText(row.title, row.name) ?? "",
				cwd: statusText(row.cwd, row.directory) ?? "",
				parentSession: statusText(row.parentSession),
				updatedAt: statusTime(row.updatedAt),
				localSeq,
				localEvents,
				ackedSeq,
				ackedAt: statusTime(row.ackedAt, upstream?.at),
				upstreamCode: statusText(upstream?.code, row.upstreamCode),
				upstreamNote: statusText(upstream?.note),
				sizeBytes: statusNumber(row.sizeBytes, row.bytes, row.size) ?? null,
				// undefined keeps an older payload honest: the page then infers emptiness itself.
				isEmpty: typeof row.isEmpty === "boolean" ? row.isEmpty : void 0,
				state: statusState(row.state, ackedSeq)
			};
		}
		/**
		* Narrow the Host payload into the rows, counts and notices this page renders.
		* A Host field rename stops here: nothing below reads the wire shape.
		* @param payload - decoded Host payload, or nothing before the first read.
		* @returns rows plus the counts and flags shown above them.
		*/
		function readUploadReport(payload) {
			const rows = Array.isArray(payload?.rows) ? payload.rows.map(statusRow) : [];
			const declared = statusRecord(payload?.totals) ?? {};
			const counted = (state) => rows.reduce((total, row) => total + (row.state === state ? 1 : 0), 0);
			const task = statusRecord(payload?.backfill);
			const caps = statusRecord(task?.limits);
			const capDefaults = statusRecord(task?.defaults);
			// A conversation the Host marks empty says nothing about uploads, and hundreds of
			// them would bury the rows that can. An older payload carries no flag, so a row
			// stays visible when it holds events or an acknowledgement.
			const visible = rows.filter((row) => row.isEmpty === void 0 ? (row.localEvents ?? 0) > 0 || row.ackedSeq !== null : row.isEmpty !== true);
			return {
				rows,
				visible,
				hiddenEmpty: rows.length - visible.length,
				// Counted over the rows the list can show: an empty session is never uploadable,
				// so counting it in a card would promise rows the filter cannot deliver.
				counts: visible.reduce((tally, row) => {
					tally[row.state] = (tally[row.state] ?? 0) + 1;
					return tally;
				}, {
					uploaded: 0,
					partial: 0,
					never: 0
				}),
				generatedAt: statusTime(payload?.generatedAt),
				enabled: payload?.enabled !== false,
				truncated: payload?.truncated === true,
				endpoint: statusText(payload?.endpoint),
				// A payload without a task describes a Host that is not uploading, so nothing shows.
				backfill: {
					running: task?.running === true,
					startedAt: statusTime(task?.startedAt),
					finishedAt: statusTime(task?.finishedAt),
					sessions: statusNumber(task?.sessions) ?? 0,
					bytes: statusNumber(task?.bytes) ?? 0,
					completed: statusNumber(task?.completed) ?? 0,
					failed: statusNumber(task?.failed) ?? 0,
					skipped: statusNumber(task?.skipped) ?? 0,
					sentRecords: statusNumber(task?.sentRecords) ?? 0,
					lastError: statusText(task?.lastError),
					limits: {
						maxSessions: statusNumber(caps?.maxSessions) ?? 50,
						maxBytes: statusNumber(caps?.maxBytes) ?? 209715200
					},
					// The caps every run uses; undefined when the Host publishes none.
					defaults: capDefaults === void 0 ? void 0 : {
						maxSessions: statusNumber(capDefaults.maxSessions) ?? 50,
						maxBytes: statusNumber(capDefaults.maxBytes) ?? 209715200
					}
				},
				// Conversations with content left out by the Host row cap; zero when nothing was cut.
				moreSessions: typeof payload?.moreSessions === "number" && Number.isFinite(payload.moreSessions) ? payload.moreSessions : 0,
				totals: {
					sessions: statusNumber(declared.sessions) ?? rows.length,
					uploaded: statusNumber(declared.uploaded) ?? counted("uploaded"),
					partial: statusNumber(declared.partial) ?? counted("partial"),
					never: statusNumber(declared.never) ?? counted("never"),
					events: statusNumber(declared.events) ?? rows.reduce((sum, row) => sum + (row.localEvents ?? 0), 0),
					ackedEvents: statusNumber(declared.ackedEvents) ?? rows.reduce((sum, row) => sum + (row.ackedSeq ?? 0), 0)
				}
			};
		}
		/**
		* Filter rows by title, session id and working directory.
		* @param rows - display rows.
		* @param query - raw search box text.
		* @returns the matching rows, or every row for a blank query.
		*/
		function filterStatusRows(rows, query) {
			const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
			if (needle === "") return rows;
			return rows.filter((row) => row.sessionId.toLowerCase().includes(needle) || row.title.toLowerCase().includes(needle) || row.cwd.toLowerCase().includes(needle));
		}
		/** Shorten a session id for the row and the untitled fallback. */
		function shortSessionId(sessionId) {
			return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
		}
		/**
		* Compact byte count for a fact line.
		* @param bytes - size in bytes.
		* @returns a short size such as `12.3 KB`.
		*/
		function formatBytes(bytes) {
			const units = ["B", "KB", "MB", "GB"];
			let value = bytes;
			let index = 0;
			while (value >= 1024 && index < units.length - 1) {
				value = value / 1024;
				index++;
			}
			const rounded = index === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
			return `${rounded} ${units[index]}`;
		}
		/**
		* Relative copy for one acknowledgement instant.
		* @param at - acknowledgement instant in epoch milliseconds.
		* @param now - render instant in epoch milliseconds.
		* @param t - active locale lookup.
		* @returns localized relative time.
		*/
		function relativeStatusTime(at, now, t) {
			const seconds = Math.max(0, Math.round((now - at) / 1000));
			if (seconds < 10) return t("justNow");
			if (seconds < 60) return t("secondsAgo", { count: seconds });
			const minutes = Math.round(seconds / 60);
			if (minutes < 60) return t("minutesAgo", { count: minutes });
			const hours = Math.round(minutes / 60);
			if (hours < 24) return t("hoursAgo", { count: hours });
			return t("daysAgo", { count: Math.round(hours / 24) });
		}
		//#endregion
		//#region ReportFeed
		/**
		* Reader for the Host report route. Concurrent callers share one in-flight
		* read, and a failed read keeps the last good payload on screen.
		*/
		var ReportFeed = class {
			state = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
				status: "idle",
				report: void 0,
				error: void 0
			});
			pending;
			/** @returns the current snapshot (stable reference until the next change). */
			getSnapshot() {
				return this.state.getSnapshot();
			}
			/**
			* Observe snapshot replacements.
			* @param listener - invoked after each snapshot change.
			* @returns the disposer removing this listener.
			*/
			subscribe(listener) {
				return this.state.subscribe(listener);
			}
			/** Read the route, sharing one read already on the wire. @returns settlement after this read. */
			load() {
				if (this.pending !== void 0) return this.pending;
				this.state.update((draft) => {
					draft.status = "loading";
					draft.error = void 0;
				});
				const settle = () => {
					this.pending = void 0;
				};
				this.pending = readStatusRoute().then((report) => {
					this.state.update((draft) => {
						draft.status = "ready";
						draft.report = report;
						draft.error = void 0;
					});
					settle();
				}, (error) => {
					this.state.update((draft) => {
						draft.status = "failed";
						draft.error = { detail: error instanceof Error ? error.message : String(error) };
					});
					settle();
				});
				return this.pending;
			}
		};
		//#endregion
		/** Page sizes offered under the list; the rows are already in memory. */
		const STATUS_PAGE_SIZES = [
			20,
			50,
			100,
			200
		];
		/** Rows per page before the reader picks another size. */
		const STATUS_PAGE_SIZE_DEFAULT = 50;

		//#region UploadStatusRow
		/**
		* One conversation's upload state.
		* @param props - display row, render instant and localized copy.
		* @returns the list row.
		*/
		function UploadStatusRow({ row, now, t }) {
			const id = shortSessionId(row.sessionId);
			// Progress is always a count of events: ackedSeq is the last confirmed index.
			const acknowledged = row.ackedSeq === null ? null : row.ackedSeq + 1;
			const known = row.localEvents !== null;
			const facts = [t("sessionLabel", { id: id === "" ? t("unknownSession") : id })];
			if (known) facts.push(t("events", { count: row.localEvents }));
			else if (acknowledged === null) facts.push(t("eventsUnknown"));
			if (row.sizeBytes !== null && row.sizeBytes > 0) facts.push(t("logSize", { size: formatBytes(row.sizeBytes) }));
			if (acknowledged === null) facts.push(t("noAck"));
			else if (row.state === "partial") {
				// The badge spells the ratio when the count is known, so only the open end needs a fact.
				if (!known) facts.push(t("partialOpen", { acked: acknowledged }));
			} else if (known) facts.push(t("ackedRange", {
				acked: acknowledged,
				total: row.localEvents
			}));
			else facts.push(t("ackedOnly", { acked: acknowledged }));
			if (row.parentSession !== void 0) facts.push(t("childSession"));
			const ack = [];
			if (row.upstreamCode !== void 0) ack.push(/^\d{3}$/.test(row.upstreamCode) ? `HTTP ${row.upstreamCode}` : row.upstreamCode);
			if (row.ackedAt !== void 0) ack.push(relativeStatusTime(row.ackedAt, now, t));
			return (0, react_jsx_runtime.jsxs)("li", {
				className: UploadStatus_module_css_default.row,
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: UploadStatus_module_css_default.rowMain,
					children: [
						(0, react_jsx_runtime.jsx)("div", {
							className: UploadStatus_module_css_default.rowTitle,
							title: row.title === "" ? row.sessionId : row.title,
							children: row.title === "" ? id === "" ? t("unknownSession") : id : row.title
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: UploadStatus_module_css_default.rowPath,
							children: row.cwd === "" ? t("pathUnknown") : row.cwd
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: UploadStatus_module_css_default.rowFacts,
							children: facts.map((fact) => (0, react_jsx_runtime.jsx)("span", { children: fact }, fact))
						})
					]
				}), (0, react_jsx_runtime.jsxs)("div", {
					className: UploadStatus_module_css_default.rowSide,
					children: [(0, react_jsx_runtime.jsx)("span", {
						className: UploadStatus_module_css_default.badge,
						"data-state": row.state,
						children: row.state === "uploaded" ? t("statusUploaded") : row.state === "partial" ? acknowledged !== null && known ? t("statusPartial", {
							acked: acknowledged,
							total: row.localEvents
						}) : t("statusPartialUnknown") : t("statusNever")
					}), (0, react_jsx_runtime.jsx)("span", {
						className: UploadStatus_module_css_default.ack,
						title: row.upstreamNote,
						children: ack.length === 0 ? t("noAck") : ack.join(" · ")
					})]
				})]
			});
		}
		//#endregion
		//#region UploadStatusTab
		/**
		* Upload status tab: totals, the two category filters, search, the catch-up tool
		* and one row per conversation.
		* @param props - report hook, route reader and localized copy.
		* @returns the Settings tab page.
		*/
		function UploadStatusTab({ useFeed, load, t }) {
			const snapshot = useFeed((value) => value);
			const [query, setQuery] = (0, react.useState)("");
			const [filter, setFilter] = (0, react.useState)("all");
			const [page, setPage] = (0, react.useState)(1);
			const [pageSize, setPageSize] = (0, react.useState)(STATUS_PAGE_SIZE_DEFAULT);
			const [starting, setStarting] = (0, react.useState)(false);
			const [notice, setNotice] = (0, react.useState)(null);
			const [refreshing, setRefreshing] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				load();
			}, []);
			const view = (0, react.useMemo)(() => readUploadReport(snapshot.report), [snapshot.report]);
			const task = view.backfill;
			// The Host rebuilds the report at most once every five seconds, so a faster
			// clock would only read the same cached value back.
			(0, react.useEffect)(() => {
				const handle = setInterval(() => {
					load();
				}, 5000);
				return () => {
					clearInterval(handle);
				};
			}, []);
			const filtered = (0, react.useMemo)(() => filter === "all" ? view.visible : view.visible.filter((row) => filter === "uploaded" ? row.state === "uploaded" : row.state !== "uploaded"), [view.visible, filter]);
			const rows = (0, react.useMemo)(() => filterStatusRows(filtered, query), [filtered, query]);
			const total = rows.length;
			const pageCount = Math.max(1, Math.ceil(total / pageSize));
			// A refresh can shrink the list: keep the reader on a page that still exists.
			const currentPage = Math.min(Math.max(1, page), pageCount);
			const pageFrom = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
			const pageTo = Math.min(currentPage * pageSize, total);
			const pageRows = (0, react.useMemo)(() => rows.slice((currentPage - 1) * pageSize, currentPage * pageSize), [rows, currentPage, pageSize]);
			const now = Date.now();
			const loading = snapshot.status === "idle" || snapshot.status === "loading";
			const phase = snapshot.report !== void 0 ? "ready" : loading ? "loading" : "failed";
			const failure = snapshot.error;
			// One line carries the whole bookkeeping: what is shown, what was hidden, what the row cap cut.
			const summaryKey = view.hiddenEmpty > 0 ? view.moreSessions > 0 ? "visibleSummaryHiddenMore" : "visibleSummaryHidden" : view.moreSessions > 0 ? "visibleSummaryMore" : "visibleSummary";
			const summaryText = t(summaryKey, {
				visible: rows.length,
				sessions: view.totals.sessions,
				hidden: view.hiddenEmpty,
				more: view.moreSessions
			});
			// A card with a filter toggles it; the totals stay read-only.
			const cards = [{
				id: "sessions",
				label: t("summarySessions"),
				value: view.totals.sessions
			}, {
				id: "uploaded",
				label: t("summaryUploaded"),
				value: view.counts.uploaded,
				filter: "uploaded",
				tone: "uploaded"
			}, {
				id: "partial",
				label: t("summaryPartial"),
				value: view.counts.partial
			}, {
				id: "never",
				label: t("summaryNever"),
				value: view.counts.never,
				filter: "pending"
			}, {
				id: "ackedEvents",
				label: t("summaryAckedEvents"),
				value: view.totals.ackedEvents
			}];
			const capsNote = task.defaults === void 0 ? void 0 : t("backfillCaps", {
				sessions: task.defaults.maxSessions,
				mb: Math.round(task.defaults.maxBytes / 1048576)
			});
			/** One click; the run takes the caps the Host publishes. */
			const startBackfill = () => {
				if (starting || task.running) return;
				setStarting(true);
				setNotice(null);
				requestBackfill({
					maxSessions: null,
					maxBytes: null
				}).then((answer) => {
					setStarting(false);
					if (answer.kind === "started") {
						load();
						return;
					}
					if (answer.kind === "busy") {
						setNotice({ tone: "note", text: t("backfillBusy") });
						load();
						return;
					}
					if (answer.kind === "invalid") {
						setNotice({ tone: "error", text: t("backfillInvalid", { detail: answer.detail }) });
						return;
					}
					setNotice({ tone: "error", text: t("backfillFailed", { detail: answer.status > 0 ? `HTTP ${answer.status}` : answer.detail }) });
				});
			};
			/** The button asks for a read; the poller does not, so only the click shows progress. */
			const refreshNow = () => {
				if (refreshing) return;
				setRefreshing(true);
				Promise.resolve(load()).then(() => {
					setRefreshing(false);
				}, () => {
					setRefreshing(false);
				});
			};
			const body = phase === "loading" ? (0, react_jsx_runtime.jsx)("p", {
				className: UploadStatus_module_css_default.note,
				children: t("loading")
			}) : phase === "failed" ? (0, react_jsx_runtime.jsx)("p", {
				className: UploadStatus_module_css_default.error,
				children: t("loadFailed", {
					path: STATUS_REPORT_ROUTE,
					detail: failure?.detail ?? "-"
				})
			}) : rows.length === 0 ? (0, react_jsx_runtime.jsx)("p", {
				className: UploadStatus_module_css_default.note,
				children: query.trim() !== "" || filter !== "all" ? t("emptySearch") : view.rows.length === 0 ? t("empty") : t("emptyAllHidden")
			}) : (0, react_jsx_runtime.jsx)("ul", {
				className: UploadStatus_module_css_default.list,
				children: pageRows.map((row) => (0, react_jsx_runtime.jsx)(UploadStatusRow, {
					row,
					now,
					t
				}, row.key))
			});
			return (0, react_jsx_runtime.jsxs)("div", {
				className: UploadStatus_module_css_default.section,
				children: [
					phase === "ready" ? (0, react_jsx_runtime.jsx)("ul", {
						className: UploadStatus_module_css_default.stats,
						children: cards.map((card) => card.filter === void 0 ? (0, react_jsx_runtime.jsxs)("li", {
							className: UploadStatus_module_css_default.stat,
							children: [(0, react_jsx_runtime.jsx)("span", {
								className: UploadStatus_module_css_default.statLabel,
								children: card.label
							}), (0, react_jsx_runtime.jsx)("span", {
								className: UploadStatus_module_css_default.statValue,
								children: String(card.value)
							})]
						}, card.id) : (0, react_jsx_runtime.jsx)("li", {
							className: UploadStatus_module_css_default.statInteractive,
							children: (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: UploadStatus_module_css_default.statButton,
								"aria-pressed": filter === card.filter ? "true" : "false",
								"data-active": filter === card.filter ? "true" : void 0,
								"data-tone": card.tone,
								onClick: () => {
									setFilter(filter === card.filter ? "all" : card.filter); setPage(1);
								},
								children: [(0, react_jsx_runtime.jsx)("span", {
									className: UploadStatus_module_css_default.statLabel,
									children: card.label
								}), (0, react_jsx_runtime.jsx)("span", {
									className: UploadStatus_module_css_default.statValue,
									children: String(card.value)
								})]
							})
						}, card.id))
					}) : null,
					phase === "ready" && !task.running && task.finishedAt !== void 0 ? (0, react_jsx_runtime.jsx)("p", {
						className: UploadStatus_module_css_default.note,
						children: task.sessions === 0 ? task.skipped > 0 ? t("backfillTooSmall", {
							skipped: task.skipped
						}) : t("backfillNothing") : t("backfillResult", {
							completed: task.completed,
							sentRecords: task.sentRecords
						}) + (task.failed > 0 ? t("backfillResultFailed", { failed: task.failed }) : "")
					}) : null,
					phase === "ready" && !task.running && task.lastError !== void 0 ? (0, react_jsx_runtime.jsx)("p", {
						className: UploadStatus_module_css_default.error,
						children: t("backfillLastError", { detail: task.lastError })
					}) : null,
					notice === null ? null : (0, react_jsx_runtime.jsx)("p", {
						className: notice.tone === "error" ? UploadStatus_module_css_default.error : UploadStatus_module_css_default.note,
						children: notice.text
					}),
					phase === "ready" && view.enabled === false ? (0, react_jsx_runtime.jsx)("p", {
						className: UploadStatus_module_css_default.banner,
						children: t("disabledBanner")
					}) : null,
					// The actions share the timestamp line: one row, timestamp left, tools right.
					phase === "ready" ? (0, react_jsx_runtime.jsxs)("div", {
						className: UploadStatus_module_css_default.metaRow,
						children: [(0, react_jsx_runtime.jsx)("p", {
							className: UploadStatus_module_css_default.meta,
							children: view.generatedAt === void 0 ? t("generatedMissing") : t("generatedAt", { time: new Date(view.generatedAt).toLocaleString() })
						}), (0, react_jsx_runtime.jsxs)("div", {
							className: UploadStatus_module_css_default.tools,
							children: [capsNote === void 0 ? null : (0, react_jsx_runtime.jsx)("span", {
								className: UploadStatus_module_css_default.caps,
								children: capsNote
							}), (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: UploadStatus_module_css_default.backfill,
								onClick: startBackfill,
								disabled: starting || task.running,
								children: task.running ? t("backfillRunning", {
									completed: task.completed,
									sessions: task.sessions
								}) : t("backfillStart")
							}), (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: UploadStatus_module_css_default.refresh,
								onClick: refreshNow,
								disabled: refreshing,
								children: refreshing ? t("refreshing") : t("refresh")
							})]
						})]
					}) : null,
					phase === "ready" && view.endpoint !== void 0 ? (0, react_jsx_runtime.jsx)("p", {
						className: UploadStatus_module_css_default.meta,
						children: t("endpointLabel", { endpoint: view.endpoint })
					}) : null,
					phase === "ready" ? (0, react_jsx_runtime.jsx)("p", {
						className: UploadStatus_module_css_default.meta,
						children: summaryText
					}) : null,
					phase === "failed" || failure === void 0 ? null : (0, react_jsx_runtime.jsx)("p", {
						className: UploadStatus_module_css_default.error,
						children: t("loadFailed", {
							path: STATUS_REPORT_ROUTE,
							detail: failure.detail
						})
					}),
					phase === "ready" && view.truncated ? (0, react_jsx_runtime.jsx)("p", {
						className: UploadStatus_module_css_default.note,
						children: t("truncatedNotice")
					}) : null,
					phase === "ready" && view.visible.length > 0 ? (0, react_jsx_runtime.jsx)("label", {
						className: UploadStatus_module_css_default.search,
						children: (0, react_jsx_runtime.jsx)("input", {
							type: "search",
							value: query,
							placeholder: t("search"),
							"aria-label": t("search"),
							onChange: (event) => {
								setQuery(event.target.value); setPage(1);
							}
						})
					}) : null,
					phase === "ready" && filter !== "all" ? (0, react_jsx_runtime.jsx)("p", {
						className: UploadStatus_module_css_default.note,
						children: t("filterActive", { name: filter === "uploaded" ? t("summaryUploaded") : t("summaryNever") })
					}) : null,
					total === 0 ? null : (0, react_jsx_runtime.jsxs)("div", {
						className: UploadStatus_module_css_default.pager,
						children: [(0, react_jsx_runtime.jsx)("span", {
							className: UploadStatus_module_css_default.pagerCount,
							children: t("pagerRange", {
								from: pageFrom,
								to: pageTo,
								total
							})
						}), (0, react_jsx_runtime.jsxs)("div", {
							className: UploadStatus_module_css_default.pagerTools,
							children: [(0, react_jsx_runtime.jsxs)("label", {
								className: UploadStatus_module_css_default.pagerSize,
								children: [(0, react_jsx_runtime.jsx)("span", {
									children: t("pagerSize")
								}), (0, react_jsx_runtime.jsx)("select", {
									value: String(pageSize),
									"aria-label": t("pagerSize"),
									onChange: (event) => {
										setPageSize(Number(event.target.value));
										setPage(1);
									},
									children: STATUS_PAGE_SIZES.map((size) => (0, react_jsx_runtime.jsx)("option", {
										value: String(size),
										children: String(size)
									}, size))
								})]
							}), (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: UploadStatus_module_css_default.pagerButton,
								onClick: () => {
									setPage(currentPage - 1);
								},
								disabled: currentPage <= 1,
								children: t("pagerPrevious")
							}), (0, react_jsx_runtime.jsx)("span", {
								className: UploadStatus_module_css_default.pagerPage,
								children: t("pagerPage", {
									page: currentPage,
									pages: pageCount
								})
							}), (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: UploadStatus_module_css_default.pagerButton,
								onClick: () => {
									setPage(currentPage + 1);
								},
								disabled: currentPage >= pageCount,
								children: t("pagerNext")
							})]
						})]
					}),
					body,
				]
			});
		}
		//#endregion
		//#region locales
		/** Copy for the universal Session-log upload preference. */
		const en = {
			title: "Upload Session Log for every conversation (plugin-provided)",
			description: "Not limited to the official model API; helps improve DeepSeek models and products.",
			saved: "Preference saved",
			failed: "Could not save preference"
		};
		/** Chinese preference copy. */
		const zh = {
			title: "上传全部会话日志（插件提供）",
			description: "不限官方模型 API，任何对话都会上传，帮助改进 DeepSeek 模型与产品。",
			saved: "设置已保存",
			failed: "无法保存设置"
		};
		//#endregion
		//#region status locales
		/** English copy for the upload-status tab. */
		const statusEn = {
			tab: "Upload status",
			summarySessions: "Sessions",
			summaryUploaded: "Uploaded",
			summaryPartial: "Partial",
			summaryNever: "Not uploaded",
			summaryAckedEvents: "Uploaded events",
			generatedAt: "Generated {time}",
			generatedMissing: "No data generated yet",
			endpointLabel: "Collector {endpoint}",
			refresh: "Refresh",
			"filterActive": "Filtered: {name}",
			"pagerRange": "{from}-{to} of {total}",
			"pagerSize": "Per page",
			"pagerPrevious": "Previous",
			"pagerNext": "Next",
			"pagerPage": "Page {page} / {pages}",
			"backfillStart": "Upload all",
			"backfillCaps": "up to {sessions} / {mb} MB",
			"backfillRunning": "Uploading {completed}/{sessions}",
			"backfillResult": "Uploaded {completed} conversations ({sentRecords} records)",
			"backfillResultFailed": "; {failed} failed",
			"backfillBusy": "The previous batch is still uploading",
			"backfillInvalid": "Invalid request: {detail}",
			"backfillFailed": "Could not start {detail}",
			"backfillNothing": "No conversations need uploading",
			"backfillTooSmall": "The limit is too small: {skipped} conversations exceed the per-run byte cap. Raise the MB limit and try again.",
			"backfillLastError": "Last upload failed: {detail}",
			"refreshing": "Refreshing…",
			search: "Search title, session ID or directory",
			loading: "Reading upload records…",
			loadFailed: "Could not read {path} ({detail}).",
			empty: "No conversations to summarize yet.",
			emptySearch: "No conversations match this search.",
			disabledBanner: "Uploading is switched off, so new events stay on this machine.",
			truncatedNotice: "Only the most recent conversations are listed.",
			visibleSummary: "{visible} of {sessions} conversations shown",
			visibleSummaryHidden: "{visible} of {sessions} conversations shown; {hidden} empty conversations hidden (no events)",
			visibleSummaryMore: "{visible} of {sessions} conversations shown; {more} conversations with content are not shown (at most 500 are listed)",
			visibleSummaryHiddenMore: "{visible} of {sessions} conversations shown; {hidden} empty conversations hidden; {more} conversations with content are not shown (at most 500 are listed)",
			emptyAllHidden: "Every local conversation is empty, so there is nothing to show.",
			statusUploaded: "Uploaded",
			statusPartial: "Partial {acked}/{total} events",
			statusPartialUnknown: "Partially uploaded",
			statusNever: "Not uploaded",
			sessionLabel: "Session {id}",
			pathUnknown: "Unknown directory",
			unknownSession: "Untitled conversation",
			childSession: "Subagent session",
			events: "{count} events",
			eventsUnknown: "event count unknown",
			logSize: "{size} log",
			ackedRange: "{acked}/{total} events uploaded",
			ackedOnly: "{acked} events uploaded · total unknown",
			partialOpen: "Confirmed through #{acked}; content followed",
			noAck: "No upstream confirmation",
			justNow: "just now",
			secondsAgo: "{count}s ago",
			minutesAgo: "{count}m ago",
			hoursAgo: "{count}h ago",
			daysAgo: "{count}d ago"
		};
		/** Chinese copy for the upload-status tab. */
		const statusZh = {
			tab: "上传状态",
			summarySessions: "会话总数",
			summaryUploaded: "已上传",
			summaryPartial: "部分上传",
			summaryNever: "未上传",
			summaryAckedEvents: "已上传事件",
			generatedAt: "数据生成于 {time}",
			generatedMissing: "尚未生成数据",
			endpointLabel: "采集端 {endpoint}",
			refresh: "刷新",
			"filterActive": "筛选中：{name}",
			"pagerRange": "第 {from}-{to} 个 / 共 {total} 个",
			"pagerSize": "每页",
			"pagerPrevious": "上一页",
			"pagerNext": "下一页",
			"pagerPage": "第 {page} / {pages} 页",
			"backfillStart": "一键上传",
			"backfillCaps": "每次最多 {sessions} 个 / {mb} MB",
			"backfillRunning": "上传中 {completed}/{sessions}",
			"backfillResult": "已补传 {completed} 个会话（发送 {sentRecords} 条记录）",
			"backfillResultFailed": "，失败 {failed} 个",
			"backfillBusy": "上一批还在上传中",
			"backfillInvalid": "请求无效：{detail}",
			"backfillFailed": "启动失败 {detail}",
			"backfillNothing": "没有需要补传的会话",
			"backfillTooSmall": "限额太小：有 {skipped} 个会话超出了单次字节上限，把 MB 上限调大再试",
			"backfillLastError": "上次上传出错：{detail}",
			"refreshing": "刷新中…",
			search: "搜索标题、会话 ID 或目录",
			loading: "正在读取上传记录…",
			loadFailed: "无法读取 {path}（{detail}）。",
			empty: "还没有可用于统计的会话。",
			emptySearch: "没有匹配的会话。",
			disabledBanner: "上传开关已关闭，新事件不会再上传。",
			truncatedNotice: "仅列出最近的会话。",
			visibleSummary: "可见 {visible} 个会话（共 {sessions} 个）",
			visibleSummaryHidden: "可见 {visible} 个会话（共 {sessions} 个），已隐藏 {hidden} 个空会话（没有任何事件）",
			visibleSummaryMore: "可见 {visible} 个会话（共 {sessions} 个），另有 {more} 个有内容的会话未展示（最多展示 500 个）",
			visibleSummaryHiddenMore: "可见 {visible} 个会话（共 {sessions} 个），已隐藏 {hidden} 个空会话；另有 {more} 个有内容的会话未展示（最多展示 500 个）",
			emptyAllHidden: "本地会话都没有任何事件，暂无可显示的上传记录。",
			statusUploaded: "已上传",
			statusPartial: "部分 {acked}/{total} 条",
			statusPartialUnknown: "部分上传",
			statusNever: "未上传",
			sessionLabel: "会话 {id}",
			pathUnknown: "未知目录",
			unknownSession: "未命名会话",
			childSession: "子代理会话",
			events: "事件 {count} 条",
			eventsUnknown: "事件数未知",
			logSize: "日志 {size}",
			ackedRange: "已上传 {acked}/{total} 条",
			ackedOnly: "已上传 {acked} 条 · 事件总数未知",
			partialOpen: "已确认到第 {acked} 条 · 之后仍有新内容",
			noAck: "无上游确认",
			justNow: "刚刚",
			secondsAgo: "{count} 秒前",
			minutesAgo: "{count} 分钟前",
			hoursAgo: "{count} 小时前",
			daysAgo: "{count} 天前"
		};
		//#endregion
		//#region client entry
		/** Services used by the browser companion. */
		const inject = [
			"slots",
			"locale",
			"configForms"
		];
		/**
		* Register the preference while its Host configuration is available.
		* @param ctx - browser plugin context.
		*/
		function apply(ctx) {
			const locale = "settings.sessionLogUniversal";
			// Must equal the Host loader entry id (the patch row id), which is how
			// dsh-settings keys its namespaces.
			const namespace = "dsh-session-log-universal";
			ctx.effect(() => ctx.locale.register(locale, {
				en,
				zh
			}));
			const statusLocale = "settings.sessionLogUniversalStatus";
			const statusT = ctx.locale.bind(statusLocale);
			ctx.effect(() => ctx.locale.register(statusLocale, {
				en: statusEn,
				zh: statusZh
			}));
			const form = ctx.configForms.get(namespace);
			const preference = new UploadPreference(form);
			const face = () => ({
				hooks: {
					upload: form,
					mutation: preference.state
				},
				setEnabled: (enabled) => preference.setEnabled(enabled),
				dismiss: () => {
					preference.dismiss();
				}
			});
			ctx.effect(() => ctx.configForms.whileServed([namespace], () => ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: namespace,
				order: 91,
				locale,
				inject: face
			}, UploadRow))));
			const feed = new ReportFeed();
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "upload-status",
				order: 20,
				label: () => statusT("tab"),
				locale: statusLocale,
				inject: () => ({
					hooks: { feed },
					load: () => feed.load()
				})
			}, UploadStatusTab));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "session-log-universal-toast",
				locale,
				inject: face
			}, UploadToast));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
