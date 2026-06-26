const $ = (id) => document.getElementById(id);

const setText = (id, value) => {
  const el = $(id);
  if (el) el.textContent = value;
};

const state = {
  page: localStorage.getItem("adaptiveFlags.page") || "dashboard",
  activities: [],
  features: [],
  evaluations: [],
  events: [],
  experiments: [],
  selectedExperimentId: Number(localStorage.getItem("adaptiveFlags.experimentId")) || null,
  experimentResult: null,
  experimentResultMessage: "Selecione um teste para visualizar o resultado.",
  modelRuns: [],
  experimentsCount: 0,
  modelStatus: null,
  modelStatusMessage: "Use as ações desta página para carregar os detalhes do modelo.",
  lastSyncAt: null,
  lastStatusPayload: "Sem detalhes disponíveis.",
  statusHistory: [],
  featureFilter: "",
  eventsFilter: "",
  eventsPage: 1,
  eventsPerPage: 25,
  charts: { release: null, source: null, timeline: null },
};

function baseUrl() {
  const raw = $("baseUrl")?.value?.trim();
  const resolved = raw || localStorage.getItem("adaptiveFlags.baseUrl")?.trim() || window.location.origin;
  return resolved.replace(/\/$/, "");
}

function headers() {
  const token = $("token")?.value?.trim() || localStorage.getItem("adaptiveFlags.token")?.trim() || "";
  const out = {};
  if (token) out.Authorization = `Bearer ${token}`;
  return out;
}

const STATIC_DATA_ROUTES = {
  "/activities": "activities.json",
  "/features": "features.json",
  "/events": "events.json",
  "/evaluations": "evaluations.json",
  "/experiments": "experiments.json",
  "/model/status": "model_metadata.json",
  "/model/runs": "model_training_runs.json",
};

function requestPath(path) {
  return String(path ?? "").split("?")[0].replace(/\/+$/, "") || "/";
}

function requestQuery(path) {
  return new URLSearchParams(String(path ?? "").split("?")[1] || "");
}

function parseJsonValue(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeStaticRows(route, rows) {
  if (!Array.isArray(rows)) return rows;

  if (route === "/events") {
    return rows.map((row) => ({
      ...row,
      properties: parseJsonValue(row?.properties) || {},
    }));
  }

  if (route === "/evaluations") {
    return rows.map((row) => ({
      ...row,
      experiment: parseJsonValue(row?.experiment),
    }));
  }

  if (route === "/model/status") {
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      metrics: parseJsonValue(row.metrics) || null,
    };
  }

  if (route === "/model/runs") {
    return rows.map((row) => ({
      ...row,
      snapshot: parseJsonValue(row?.snapshot) || null,
    }));
  }

  return rows;
}

async function readStaticJson(fileName) {
  const started = performance.now();
  try {
    const res = await fetch(new URL(`./data/${fileName}`, window.location.href));
    const elapsed = Math.round(performance.now() - started);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data, elapsed };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: { detail: `Falha ao ler ${fileName}: ${String(error)}` },
      elapsed: Math.round(performance.now() - started),
    };
  }
}

function normalizeExperimentContext(value) {
  const parsed = parseJsonValue(value);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function buildExperimentResult(experiment, evaluations) {
  const experimentId = Number(experiment?.id ?? experiment);
  const minSamples = Number(experiment?.min_samples_per_variant || 0);
  const minLift = Number(experiment?.min_lift || 0);
  const rows = Array.isArray(evaluations)
    ? evaluations.filter((row) => Number(normalizeExperimentContext(row?.experiment)?.experiment_id) === experimentId)
    : [];

  const grouped = { A: [], B: [] };
  for (const row of rows) {
    const context = normalizeExperimentContext(row?.experiment);
    const variant = String(context?.variant || row?.ab_variant || row?.variant || "A").trim().toUpperCase();
    grouped[variant === "B" ? "B" : "A"].push(row);
  }

  const summarize = (items) => {
    const samples = items.length;
    const positives = items.filter((item) => Number(item?.enabled) === 1 || item?.enabled === true).length;
    const users = new Set(items.map((item) => String(item?.user_id ?? "").trim()).filter(Boolean)).size;
    return {
      samples,
      positives,
      users,
      rate: samples ? positives / samples : 0,
    };
  };

  const variantA = summarize(grouped.A);
  const variantB = summarize(grouped.B);
  const lift = variantB.rate - variantA.rate;

  let decision = "continue";
  if (variantA.samples >= minSamples && variantB.samples >= minSamples) {
    if (lift >= minLift) {
      decision = "stop_promote_b";
    } else if ((-lift) >= minLift) {
      decision = "stop_keep_a";
    }
  }

  return {
    decision,
    min_samples_per_variant: minSamples,
    min_lift: minLift,
    lift_b_vs_a: lift,
    variant_stats: {
      A: variantA,
      B: variantB,
    },
    user_stats: {
      A: { users: variantA.users },
      B: { users: variantB.users },
    },
  };
}

async function loadStaticRoute(path) {
  const route = requestPath(path);
  const query = requestQuery(path);
  const started = performance.now();

  if (route === "/experiments") {
    const out = await readStaticJson(STATIC_DATA_ROUTES[route]);
    out.data = normalizeStaticRows(route, out.data);
    return out;
  }

  if (route === "/events") {
    const out = await readStaticJson(STATIC_DATA_ROUTES[route]);
    const rows = normalizeStaticRows(route, Array.isArray(out.data) ? out.data : []);
    if (!out.ok) return { ...out, data: rows };

    const userId = query.get("user_id")?.trim();
    const limit = Number(query.get("limit") || "");
    let data = rows;
    if (userId) {
      data = data.filter((row) => String(row?.user_id ?? "") === userId);
    }
    if (Number.isFinite(limit) && limit > 0) {
      data = data.slice(0, limit);
    }
    return { ok: true, status: 200, data, elapsed: out.elapsed };
  }

  if (route === "/evaluations") {
    const out = await readStaticJson(STATIC_DATA_ROUTES[route]);
    const rows = normalizeStaticRows(route, Array.isArray(out.data) ? out.data : []);
    if (!out.ok) return { ...out, data: rows };

    const limit = Number(query.get("limit") || "");
    const data = Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;
    return { ok: true, status: 200, data, elapsed: out.elapsed };
  }

  if (route === "/activities" || route === "/features" || route === "/model/runs") {
    const out = await readStaticJson(STATIC_DATA_ROUTES[route]);
    const data = normalizeStaticRows(route, Array.isArray(out.data) ? out.data : []);
    return { ...out, data };
  }

  if (route === "/model/status") {
    const out = await readStaticJson(STATIC_DATA_ROUTES[route]);
    const data = normalizeStaticRows(route, Array.isArray(out.data) ? out.data : []);
    return { ...out, data };
  }

  const resultMatch = route.match(/^\/experiments\/(\d+)\/result$/);
  if (resultMatch) {
    const experimentId = Number(resultMatch[1]);
    const [experimentsOut, evaluationsOut] = await Promise.all([
      readStaticJson(STATIC_DATA_ROUTES["/experiments"]),
      readStaticJson(STATIC_DATA_ROUTES["/evaluations"]),
    ]);

    if (!experimentsOut.ok) return experimentsOut;
    if (!evaluationsOut.ok) return evaluationsOut;

    const experiments = normalizeStaticRows("/experiments", Array.isArray(experimentsOut.data) ? experimentsOut.data : []);
    const evaluations = normalizeStaticRows("/evaluations", Array.isArray(evaluationsOut.data) ? evaluationsOut.data : []);
    const experiment = experiments.find((item) => Number(item?.id) === experimentId);
    if (!experiment) {
      return {
        ok: false,
        status: 404,
        data: { detail: `Experimento ${experimentId} não encontrado.` },
        elapsed: Math.round(performance.now() - started),
      };
    }

    return {
      ok: true,
      status: 200,
      data: buildExperimentResult(experiment, evaluations),
      elapsed: Math.round(performance.now() - started),
    };
  }

  return {
    ok: false,
    status: 405,
    data: { detail: "Esta publicação é somente leitura; os dados vêm dos JSON em /adaptive-feature-flags/data." },
    elapsed: Math.round(performance.now() - started),
  };
}

function setStatus(message, data = null) {
  const summary = $("apiStatusSummary");
  const meta = $("apiStatusMeta");
  const payload = $("apiStatusPayload");
  const history = $("statusHistory");
  if (summary) summary.textContent = message;
  if (meta) meta.textContent = `Atualizado em ${new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date())}`;

  if (data === null) {
    state.lastStatusPayload = "Sem detalhes disponíveis.";
    if (payload) payload.textContent = state.lastStatusPayload;
    return;
  }

  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  state.lastStatusPayload = text;
  if (payload) payload.textContent = text;

  state.statusHistory.unshift({
    message,
    payload: text,
    at: new Date().toISOString(),
  });
  state.statusHistory = state.statusHistory.slice(0, 5);
  if (history) {
    history.innerHTML = state.statusHistory.map((entry, index) => {
      const time = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(entry.at));
      return `<button class="history-item" type="button" data-index="${index}">
        <span>${entry.message}</span>
        <small>${time}</small>
      </button>`;
    }).join("");
    history.querySelectorAll(".history-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const entry = state.statusHistory[Number(btn.dataset.index)];
        if (!entry) return;
        if (summary) summary.textContent = entry.message;
        if (meta) meta.textContent = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium" }).format(new Date(entry.at));
        if (payload) payload.textContent = entry.payload;
        state.lastStatusPayload = entry.payload;
      });
    });
  }
}

function setModelStatus(message, data = null) {
  state.modelStatusMessage = message || "Modelo carregado.";
  if (data !== null) {
    state.lastStatusPayload = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  }
  renderModelStatus();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function formatCompactNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return value == null ? "-" : String(value);
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(num);
}

function formatPercentage(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return value == null ? "-" : String(value);
  const pct = num <= 1 ? num * 100 : num;
  return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
}

function formatSignedPercentage(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return value == null ? "-" : String(value);
  const pct = Math.abs(num) <= 1 ? num * 100 : num;
  const rounded = Math.abs(pct).toFixed(1).replace(/\.0$/, "");
  if (pct > 0) return `+${rounded}%`;
  if (pct < 0) return `-${rounded}%`;
  return "0%";
}

function formatDurationMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return value == null ? "-" : String(value);
  if (num < 1000) return `${Math.round(num)} ms`;
  const seconds = num / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : seconds.toFixed(0)} s`;
}

function friendlyModelStatus(status) {
  const labels = {
    ready: "Pronto",
    training: "Treinando",
    running: "Treinando",
    idle: "Sem treino",
    pending: "Em espera",
    failed: "Falha",
    error: "Falha",
  };
  if (labels[status]) return labels[status];
  if (!status) return "Sem status definido";
  const label = status.replace(/_/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function modelStatusTone(status) {
  if (["ready", "trained", "ok"].includes(status)) return "ok";
  if (["training", "running", "pending"].includes(status)) return "warn";
  if (["failed", "error"].includes(status)) return "bad";
  return "warn";
}

function composeModelSnapshot() {
  const current = state.modelStatus || {};
  const latestRun = state.modelRuns[0]?.snapshot || {};
  return {
    ...latestRun,
    ...current,
    metrics: current.metrics || latestRun.metrics || null,
    process: current.process || latestRun.process || null,
    artifact_path: current.artifact_path || latestRun.artifact_path || null,
  };
}

function renderMetricCards(items, emptyLabel) {
  if (!items.length) return `<div class="model-empty">${escapeHtml(emptyLabel)}</div>`;
  return `<div class="model-status-grid">${items.map((item) => `
    <article class="model-stat-card">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(item.value)}</strong>
    </article>
  `).join("")}</div>`;
}

function renderModelStatus() {
  const target = $("modelStatusPreview");
  if (!target) return;

  const model = composeModelSnapshot();
  const hasModel = Boolean(
    (model?.status && model.status !== "idle") ||
    model?.model_name ||
    model?.model_version ||
    model?.trained_at ||
    model?.metrics ||
    model?.process ||
    model?.artifact_path,
  );
  if (!hasModel) {
    target.innerHTML = `<div class="model-empty">${escapeHtml(state.modelStatusMessage || "Use as ações desta página para carregar os detalhes do modelo.")}</div>`;
    return;
  }

  const metrics = model.metrics || {};
  const process = model.process || {};
  const metricItems = [
    { label: "Acurácia", value: metrics.accuracy == null ? null : formatPercentage(metrics.accuracy) },
    { label: "Precisão", value: metrics.precision == null ? null : formatPercentage(metrics.precision) },
    { label: "Revocação", value: metrics.recall == null ? null : formatPercentage(metrics.recall) },
    { label: "F1", value: metrics.f1_score == null ? null : formatPercentage(metrics.f1_score) },
    { label: "AUC ROC", value: metrics.roc_auc == null ? null : formatPercentage(metrics.roc_auc) },
  ].filter((item) => item.value !== null);

  const processItems = [
    { label: "Atividades", value: process.total_events == null ? null : formatCompactNumber(process.total_events) },
    { label: "Usuários", value: process.unique_users == null ? null : formatCompactNumber(process.unique_users) },
    { label: "Positivos", value: process.positive_events == null ? null : formatCompactNumber(process.positive_events) },
    { label: "Duração", value: process.duration_ms == null ? "Indisponível" : formatDurationMs(process.duration_ms) },
  ].filter((item) => item.value !== null);

  const featureColumns = Array.isArray(process.feature_columns) ? process.feature_columns : [];
  const benchmark = Array.isArray(process.benchmark) ? process.benchmark : [];

  target.innerHTML = `
    <div class="model-status-summary">
      <div class="model-status-main">
        <span class="pill ${modelStatusTone(model.status)}">${escapeHtml(friendlyModelStatus(model.status))}</span>
        <div class="model-status-title">
          <strong>${escapeHtml(model.model_name || "Modelo sem título")}</strong>
          <span>${escapeHtml(model.model_version || "Versão não informada")} • ${escapeHtml(model.trained_at ? formatDateTime(model.trained_at) : "Sem data de treino")}</span>
        </div>
      </div>
      ${model.artifact_path ? `<div class="model-status-path">${escapeHtml(model.artifact_path)}</div>` : ""}
    </div>
    ${state.modelStatusMessage ? `<p class="model-note">${escapeHtml(state.modelStatusMessage)}</p>` : ""}
    <div class="model-section metrics-section">
      <p class="model-section-title">Métricas</p>
      ${renderMetricCards(metricItems, "Sem métricas disponíveis.")}
    </div>
    <div class="model-section process-section">
      <p class="model-section-title">Processo</p>
      ${renderMetricCards(processItems, "Sem dados de processo disponíveis.")}
    </div>
    ${featureColumns.length ? `
      <div class="model-section columns-section">
        <p class="model-section-title">Colunas usadas</p>
        <div class="model-feature-list">
          ${featureColumns.map((column) => `<span class="pill">${escapeHtml(column)}</span>`).join("")}
        </div>
      </div>
    ` : ""}
    ${benchmark.length ? `
      <div class="model-section benchmark-section">
        <p class="model-section-title">Benchmark</p>
        <div class="model-benchmark-list">
          ${benchmark.slice(0, 4).map((entry) => `
            <div class="model-benchmark-item">
              <strong>${escapeHtml(entry.model_name || "Modelo")}</strong>
              <span>${escapeHtml(entry.f1_score == null ? "-" : formatPercentage(entry.f1_score))}</span>
            </div>
          `).join("")}
        </div>
      </div>
    ` : ""}
  `;
}

function renderModelRuns() {
  const target = $("modelRunsPreview");
  if (!target) return;

  const runs = Array.isArray(state.modelRuns) ? state.modelRuns : [];
  if (!runs.length) {
    target.innerHTML = `<div class="model-empty">O histórico aparece aqui após o primeiro treinamento.</div>`;
    return;
  }

  target.innerHTML = runs.map((run) => {
    const snapshot = run.snapshot || {};
    const metrics = snapshot.metrics || {};
    const process = snapshot.process || {};
    const durationMs = run.duration_ms ?? process.duration_ms ?? null;
    const metricText = [
      metrics.accuracy == null ? null : `Acurácia ${formatPercentage(metrics.accuracy)}`,
      metrics.f1_score == null ? null : `F1 ${formatPercentage(metrics.f1_score)}`,
      metrics.roc_auc == null ? null : `AUC ROC ${formatPercentage(metrics.roc_auc)}`,
    ].filter(Boolean).join(" • ");
    const processText = [
      process.total_events == null ? null : `${formatCompactNumber(process.total_events)} atividades`,
      process.unique_users == null ? null : `${formatCompactNumber(process.unique_users)} usuários`,
      process.positive_events == null ? null : `${formatCompactNumber(process.positive_events)} positivos`,
      durationMs == null ? null : `Duração ${formatDurationMs(durationMs)}`,
    ].filter(Boolean).join(" • ");

    return `
      <article class="model-run-item">
        <div class="model-run-head">
          <div class="model-run-title">
            <strong>${escapeHtml(run.model_version || "Versão sem título")}</strong>
            <small>${escapeHtml(run.trained_at ? formatDateTime(run.trained_at) : "Sem data de treino")}</small>
          </div>
          <span class="pill ${modelStatusTone(run.status)}">${escapeHtml(friendlyModelStatus(run.status))}</span>
        </div>
        ${metricText ? `<div class="model-run-line">${escapeHtml(metricText)}</div>` : ""}
        ${processText ? `<div class="model-run-line">${escapeHtml(processText)}</div>` : `<div class="model-run-line">Duração indisponível</div>`}
      </article>
    `;
  }).join("");
}

function formatLastSync(value) {
  if (!value) return "Aguardando a primeira atualização";
  return `Atualizado em ${new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(value)}`;
}

function updateDashboardSummary() {
  setText("overviewFeatures", String(state.features.length));
  setText("overviewEvents", String(state.events.length));
  const modelState = state.modelStatus?.status || state.modelRuns[0]?.status;
  setText("overviewModel", modelState && modelState !== "idle" ? "Disponível" : "Sem dados");
  setText("overviewExperiments", String(state.experimentsCount || state.experiments.length || 0));
  setText("overviewSync", formatLastSync(state.lastSyncAt));
  const m = metricsFromEvaluations();
  setText("compareMl", String(m.ml));
  setText("compareRollout", String(m.rollout));
  setText("compareDelta", String(Math.abs(m.ml - m.rollout)));
  setText("mEvents", `${state.events.length} / ${state.features.length}`);
  renderDashboardTables();
}

function markDashboardSync() {
  state.lastSyncAt = new Date();
  updateDashboardSummary();
}

function setPage(page, { fromHash = false } = {}) {
  const next = ["dashboard", "insights", "experiments", "features", "evaluation", "events", "governance"].includes(page) ? page : "dashboard";
  state.page = next;
  localStorage.setItem("adaptiveFlags.page", next);

  document.querySelectorAll(".page").forEach((el) => {
    el.classList.toggle("active", el.dataset.page === next);
  });

  document.querySelectorAll(".nav-item").forEach((btn) => {
    const active = btn.dataset.page === next;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-current", active ? "page" : "false");
  });

  const desiredHash = `#${next}`;
  if (!fromHash && window.location.hash !== desiredHash) {
    window.location.hash = next;
    return;
  }

  const target = document.getElementById(next);
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function setLoading(btnId, loadingText) {
  const btn = $(btnId);
  if (!btn) return () => {};
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = loadingText;
  return () => {
    btn.disabled = false;
    btn.textContent = prev;
  };
}

function setEventStatus(message, tone = "info") {
  const target = $("eventActionStatus");
  if (!target) return;
  target.textContent = message;
  target.dataset.tone = tone;
}

function setActionStatus(id, message, tone = "info") {
  const target = $(id);
  if (!target) return;
  target.textContent = message;
  target.dataset.tone = tone;
}

function normalizeNumberField(input) {
  const raw = String(input.value ?? "").trim();
  if (!raw) return;
  const value = Number(raw.replace(",", "."));
  if (!Number.isFinite(value)) return;

  const stepRaw = String(input.step || "1").trim();
  const step = stepRaw === "any" ? null : Number(stepRaw);
  const minRaw = String(input.min ?? "").trim();
  const maxRaw = String(input.max ?? "").trim();
  const min = minRaw === "" ? null : Number(minRaw);
  const max = maxRaw === "" ? null : Number(maxRaw);

  let next = value;
  if (Number.isFinite(min)) next = Math.max(min, next);
  if (Number.isFinite(max)) next = Math.min(max, next);

  let precision = 0;
  if (step !== null && Number.isFinite(step)) {
    const stepText = stepRaw;
    if (stepText.includes("e-")) {
      precision = Number(stepText.split("e-")[1] || 0);
    } else if (stepText.includes(".")) {
      precision = stepText.split(".")[1].length;
    }
    if (precision > 0) {
      const factor = 10 ** precision;
      next = Math.round(next * factor) / factor;
    } else {
      next = Math.round(next);
    }
  }

  const formatted = precision > 0 ? next.toFixed(precision) : String(Math.round(next));
  if (input.value !== formatted) {
    input.value = formatted;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function stepNumberField(input, direction) {
  const raw = String(input.value ?? "").trim();
  const value = raw === "" ? Number(input.min || 0) : Number(raw.replace(",", "."));
  if (!Number.isFinite(value)) return;

  const stepRaw = String(input.step || "1").trim();
  const step = stepRaw === "any" ? 1 : Number(stepRaw);
  if (!Number.isFinite(step) || step <= 0) return;

  const minRaw = String(input.min ?? "").trim();
  const maxRaw = String(input.max ?? "").trim();
  const min = minRaw === "" ? null : Number(minRaw);
  const max = maxRaw === "" ? null : Number(maxRaw);

  let next = value + (direction * step);
  if (Number.isFinite(min)) next = Math.max(min, next);
  if (Number.isFinite(max)) next = Math.min(max, next);

  let precision = 0;
  if (stepRaw.includes("e-")) {
    precision = Number(stepRaw.split("e-")[1] || 0);
  } else if (stepRaw.includes(".")) {
    precision = stepRaw.split(".")[1].length;
  }
  const formatted = precision > 0 ? next.toFixed(precision) : String(Math.round(next));
  input.value = formatted;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function api(path, options = {}) {
  try {
    const finalHeaders = { ...headers(), ...(options.headers || {}) };
    if (options.body !== undefined && options.body !== null && !("Content-Type" in finalHeaders)) {
      finalHeaders["Content-Type"] = "application/json";
    }

    const method = String(options.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      return {
        ok: false,
        status: 405,
        data: { detail: "Esta publicação é somente leitura; os dados vêm dos JSON em /adaptive-feature-flags/data." },
        elapsed: 0,
      };
    }
    if (method === "GET" || method === "HEAD") {
      const route = requestPath(path);
      if (STATIC_DATA_ROUTES[route] || route.startsWith("/experiments/")) {
        return await loadStaticRoute(path);
      }
    }

    const started = performance.now();
    const res = await fetch(`${baseUrl()}${path}`, { ...options, headers: finalHeaders });
    const elapsed = Math.round(performance.now() - started);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: res.ok, status: res.status, data, elapsed };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: { detail: `Falha de rede ao acessar ${path}: ${String(error)}` },
      elapsed: Math.round(performance.now() - started),
    };
  }
}

function normalizeNumber(value, fallback = null) {
  if (value === "" || value === null || value === undefined) return fallback;
  const parsed = Number(String(value).trim().replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function yesNo(value) {
  return value ? '<span class="pill ok">Sim</span>' : '<span class="pill bad">Não</span>';
}

function enabledLabel(value) {
  return value ? '<span class="pill ok">Liberado</span>' : '<span class="pill bad">Bloqueado</span>';
}

function titleCase(value) {
  const text = String(value ?? "").replace(/_/g, " ").trim();
  if (!text) return "-";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function statusLabel(value) {
  return value ? '<span class="pill ok">Ativa</span>' : '<span class="pill bad">Pausada</span>';
}

function decisionLabel(value) {
  const labels = {
    fixed: "Limite fixo",
    match_rollout: "Acompanhar cobertura",
    maximize_f1: "Automática",
    ml: "Inteligente",
    rollout: "Gradual",
    feature_disabled: "Regra pausada",
    feature_not_found: "Regra não encontrada",
    continue: "Em andamento",
    stop_promote_b: "Escolher B",
    stop_keep_a: "Manter A",
  };
  return labels[value] || value || "-";
}

function experimentStatusLabel(value) {
  return value ? '<span class="pill ok">Ativo</span>' : '<span class="pill bad">Pausado</span>';
}

function experimentDecisionTone(value) {
  if (value === "stop_promote_b") return "ok";
  if (value === "stop_keep_a") return "bad";
  return "warn";
}

function experimentDecisionMessage(value, result) {
  const stats = result?.variant_stats || {};
  const samplesA = Number(stats.A?.samples || 0);
  const samplesB = Number(stats.B?.samples || 0);
  const minSamples = Number(result?.min_samples_per_variant || 0);

  if (value === "stop_promote_b") {
    return "A variante B ficou melhor e já passou do mínimo para escolha.";
  }
  if (value === "stop_keep_a") {
    return "A variante A continua melhor. Mantenha A como padrão.";
  }
  if (samplesA < minSamples || samplesB < minSamples) {
    return "Ainda faltam amostras para tomar uma decisão segura.";
  }
  return "Os dados ainda não mostram diferença suficiente para encerrar o teste.";
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "-";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function metricsFromEvaluations() {
  const total = state.evaluations.length;
  const enabled = state.evaluations.filter((v) => v.enabled).length;
  const disabled = total - enabled;
  const bySource = (src) => state.evaluations.filter((v) => v.decision_source === src).length;
  return {
    total,
    enabled,
    disabled,
    rate: total ? (enabled / total) * 100 : 0,
    ml: bySource("ml"),
    rollout: bySource("rollout"),
    feature_disabled: bySource("feature_disabled"),
    feature_not_found: bySource("feature_not_found"),
  };
}

function activitiesList() {
  return Array.isArray(state.activities) ? state.activities : [];
}

function findActivity(key) {
  const normalized = String(key ?? "").trim();
  if (!normalized) return null;
  return activitiesList().find((activity) => activity.key === normalized) || null;
}

function activityFriendlyName(key) {
  const activity = findActivity(key);
  if (activity?.name) return activity.name;
  const labels = {
    view: "Visualização",
    viewed_feature: "Visualizou a funcionalidade",
    addtocart: "Adição ao carrinho",
    transaction: "Transação",
    used_feature: "Uso da funcionalidade",
    event: "Evento",
  };
  if (labels[key]) return labels[key];
  return titleCase(key);
}

function findFeature(key) {
  const normalized = String(key ?? "").trim();
  if (!normalized) return null;
  return (Array.isArray(state.features) ? state.features : []).find((feature) => feature.key === normalized) || null;
}

function featureFriendlyName(key) {
  const feature = findFeature(key);
  if (feature?.name) return feature.name;
  const normalized = String(key ?? "").trim();
  if (!normalized) return "-";
  return titleCase(normalized);
}

function sourceFriendlyName(value) {
  const normalized = String(value ?? "").trim();
  const labels = {
    web_app: "Aplicação web",
    mobile_app: "Aplicação mobile",
    email_campaign: "E-mail marketing",
    ui_manual: "UI manual",
  };
  if (labels[normalized]) return labels[normalized];
  if (!normalized) return "-";
  return titleCase(normalized);
}

function activityDescription(key) {
  const activity = findActivity(key);
  if (activity?.description) return activity.description;
  return "";
}

function activityOptionLabel(activity) {
  if (!activity) return "-";
  const label = activity.name || activity.key || "-";
  const key = activity.key ? ` (${activity.key})` : "";
  return `${label}${key}`;
}

function activityRowLabel(key) {
  const activity = findActivity(key);
  const identifier = String(key ?? "").trim() || activity?.key || "-";
  const description = String(activity?.description || activity?.name || "").trim();
  if (description) {
    return `<div class="activity-cell"><strong>${escapeHtml(identifier)}</strong><div class="cell-subtle">${escapeHtml(description)}</div></div>`;
  }
  return `<div class="activity-cell"><strong>${escapeHtml(identifier)}</strong></div>`;
}

function updateMetricCards() {
  const m = metricsFromEvaluations();
  $("mTotal").textContent = String(m.total);
  $("mEnabled").textContent = String(m.enabled);
  $("mDisabled").textContent = String(m.disabled);
  $("mRate").textContent = `${m.rate.toFixed(1)}%`;
  $("mMl").textContent = String(m.ml);
  $("mRollout").textContent = String(m.rollout);
  updateDashboardSummary();
}

function renderFeaturesTable() {
  const body = $("featuresBody");
  if (!body) return;
  const filter = state.featureFilter.trim().toLowerCase();
  const filtered = [...(filter
    ? state.features.filter((feature) => {
      const haystack = `${feature.name ?? ""} ${feature.key ?? ""} ${feature.description ?? ""}`.toLowerCase();
      return haystack.includes(filter);
    })
    : state.features)]
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));

  $("featuresCount").textContent = `${filtered.length} linhas`;

  if (!filtered.length) {
    body.innerHTML = '<tr><td colspan="7">Nenhuma regra encontrada.</td></tr>';
    return;
  }

  body.innerHTML = filtered.map((feature) => {
    const rollout = feature.rollout_percentage ?? "-";
    const thresholdValue = feature.ml_threshold_value ?? "-";
    const strategy = decisionLabel(feature.ml_threshold_mode);
    const rolloutText = rollout === "-" ? "-" : `${rollout}%`;
    const thresholdText = thresholdValue === "-" ? "-" : Number(thresholdValue).toFixed(2);
    return `\n<tr>\n<td>${feature.name ?? "-"}</td>\n<td>${feature.key ?? "-"}</td>\n<td>${feature.description ?? "-"}</td>\n<td>${rolloutText}</td>\n<td><span class="strategy-chip strategy-${feature.ml_threshold_mode || "fixed"}">${strategy}</span></td>\n<td>${thresholdText}</td>\n<td>${statusLabel(feature.enabled)}</td>\n</tr>`;
  }).join("");
}

function renderEvaluationTable() {
  $("evaluationCount").textContent = `${state.evaluations.length} linhas`;
  $("evalBody").innerHTML = renderEvaluationRows(state.evaluations, {
    emptyLabel: "Nenhuma avaliação registrada ainda.",
  });
}

function renderEvaluationRows(rows, { emptyLabel } = {}) {
  const items = Array.isArray(rows) ? rows : [];
  if (!items.length) {
    return `<tr><td colspan="8">${escapeHtml(emptyLabel || "Nenhuma avaliação registrada ainda.")}</td></tr>`;
  }

  return items.map((r) => `\n<tr>\n<td>${escapeHtml(r.user_id || "-")}</td>\n<td>${activityRowLabel(r.activity)}</td>\n<td>${escapeHtml(r.feature_key || "-")}</td>\n<td>${enabledLabel(r.enabled)}</td>\n<td>${decisionLabel(r.decision_source)}</td>\n<td>${escapeHtml(r.score ?? "-")}</td>\n<td>${escapeHtml(r.threshold ?? "-")}</td>\n<td>${escapeHtml(r.experiment?.variant ?? "-")}</td>\n</tr>`).join("");
}

function featureKeysFromEvents(events) {
  const stats = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const key = String(event?.feature_key || "").trim();
    if (!key) continue;
    const timestamp = Number(new Date(event.timestamp || 0));
    const current = stats.get(key) || { key, count: 0, lastSeen: 0 };
    current.count += 1;
    current.lastSeen = Math.max(current.lastSeen, Number.isFinite(timestamp) ? timestamp : 0);
    stats.set(key, current);
  }

  return [...stats.values()]
    .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
    .map((entry) => entry.key);
}

async function resolveEvaluationFeatureKeys(userId) {
  const inMemoryEvents = state.events.filter((event) => event.user_id === userId);
  const inMemoryKeys = featureKeysFromEvents(inMemoryEvents);
  if (inMemoryKeys.length) return inMemoryKeys;

  const params = new URLSearchParams({ user_id: userId });
  const out = await api(`/events?${params.toString()}`);
  if (out.ok && Array.isArray(out.data)) {
    const fromApi = featureKeysFromEvents(out.data);
    if (fromApi.length) return fromApi;
  }

  return [];
}

function renderDashboardTables() {
  const featureFilter = state.featureFilter.trim().toLowerCase();
  const filteredFeatures = featureFilter
    ? state.features.filter((feature) => {
      const haystack = `${feature.name ?? ""} ${feature.key ?? ""}`.toLowerCase();
      return haystack.includes(featureFilter);
    })
    : state.features;

  const featureEventCounts = new Map();
  const featureEvalCounts = new Map();

  for (const event of state.events) {
    const key = event.feature_key || "-";
    featureEventCounts.set(key, (featureEventCounts.get(key) || 0) + 1);
  }

  for (const evaluation of state.evaluations) {
    const key = evaluation.feature_key || "-";
    featureEvalCounts.set(key, (featureEvalCounts.get(key) || 0) + 1);
  }

  const dashboardFeaturesBody = $("dashboardFeaturesBody");
  if (dashboardFeaturesBody) {
    const attentionRows = filteredFeatures
      .map((feature) => {
        const key = feature.key || "-";
        const eventCount = featureEventCounts.get(key) || 0;
        const evalCount = featureEvalCounts.get(key) || 0;
        const isAttention = !feature.enabled || eventCount === 0 || evalCount < 3 || Number(feature.rollout_percentage ?? 0) <= 10;
        const severity = [
          feature.enabled ? 0 : 3,
          eventCount === 0 ? 2 : 0,
          evalCount < 3 ? 1 : 0,
          Number(feature.rollout_percentage ?? 0) <= 10 ? 1 : 0,
        ].reduce((sum, value) => sum + value, 0);
        return {
          feature,
          key,
          eventCount,
          evalCount,
          isAttention,
          severity,
        };
      })
      .filter((row) => row.isAttention)
      .sort((a, b) => b.severity - a.severity || String(a.feature.name ?? "").localeCompare(String(b.feature.name ?? "")))
      .slice(0, 6);

    dashboardFeaturesBody.innerHTML = attentionRows.length
      ? attentionRows.map(({ feature, eventCount, evalCount }) => {
        const rollout = feature.rollout_percentage ?? "-";
        return `\n<tr>\n<td>${feature.name ?? "-"}</td>\n<td>${feature.key ?? "-"}</td>\n<td>${rollout === "-" ? "-" : `${rollout}%`}</td>\n<td>${yesNo(feature.ml_enabled)}</td>\n<td>${statusLabel(feature.enabled)}<div class="cell-subtle">${eventCount} atividades • ${evalCount} avaliações</div></td>\n</tr>`;
      }).join("")
      : '<tr><td colspan="5">Nenhuma regra precisa de atenção agora.</td></tr>';
  }

  const dashboardEvalBody = $("dashboardEvalBody");
  if (dashboardEvalBody) {
    dashboardEvalBody.innerHTML = renderEvaluationRows(state.evaluations, {
      emptyLabel: "As avaliações aparecerão aqui após a primeira execução.",
    });
  }

  const workloadBody = $("workloadBody");
  if (workloadBody) {
    const featureLastAction = new Map();

    for (const event of state.events) {
      const key = event.feature_key || "-";
      const prev = featureLastAction.get(key);
      if (!prev || String(event.timestamp) > String(prev)) {
        featureLastAction.set(key, event.timestamp);
      }
    }

    const rows = filteredFeatures
      .map((feature) => {
        const key = feature.key || "-";
        const eventCount = featureEventCounts.get(key) || 0;
        const evalCount = featureEvalCounts.get(key) || 0;
        const rollout = feature.rollout_percentage ?? 0;
        const status = feature.enabled ? '<span class="pill ok">Em uso</span>' : '<span class="pill bad">Sem uso</span>';
        const lastAction = featureLastAction.get(key) || null;
        return {
          name: feature.name || "-",
          key,
          eventCount,
          evalCount,
          rollout,
          status,
          lastAction: lastAction ? formatDateTime(lastAction) : "-",
        };
      })
      .sort((a, b) => b.eventCount - a.eventCount || b.evalCount - a.evalCount)
      .slice(0, 6);

    workloadBody.innerHTML = rows.length
      ? rows.map((row) => `\n<tr>\n<td>${row.name}<div class="cell-subtle">${row.key}</div></td>\n<td>${row.eventCount}</td>\n<td>${row.evalCount}</td>\n<td>${row.rollout}%</td>\n<td>${row.status}</td>\n<td>${row.lastAction}</td>\n</tr>`).join("")
      : '<tr><td colspan="6">Ainda não há dados suficientes para mostrar o uso por regra.</td></tr>';
  }
}

function renderEventsTable() {
  const filter = state.eventsFilter.trim().toLowerCase();
  const filtered = filter
    ? state.events.filter((e) => {
      const haystack = `${e.user_id ?? ""} ${e.feature_key ?? ""} ${e.event_type ?? ""} ${activityFriendlyName(e.event_type ?? "")}`.toLowerCase();
      return haystack.includes(filter);
    })
    : state.events;

  const sorted = filtered;
  const perPage = Math.max(1, normalizeNumber($("eventsPerPage")?.value, 25) || 25);
  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage));
  state.eventsPage = Math.min(Math.max(1, state.eventsPage), totalPages);
  const start = (state.eventsPage - 1) * perPage;
  const pageRows = sorted.slice(start, start + perPage);
  $("eventsCount").textContent = `${sorted.length} linhas • página ${state.eventsPage}/${totalPages}`;
  $("eventsBody").innerHTML = pageRows.length
    ? pageRows.map((e) => {
      const activity = findActivity(e.event_type);
      const identifier = e.event_type || "-";
      const description = e.properties?.activity_name || activity?.description || activity?.name || activityFriendlyName(e.event_type) || "-";
      const source = sourceFriendlyName(e.source || e.properties?.source || "-");
      return `\n<tr>\n<td>${formatDateTime(e.timestamp)}</td>\n<td>${e.user_id || "-"}</td>\n<td><span class="event-identifier">${escapeHtml(identifier)}</span></td>\n<td>${escapeHtml(description)}</td>\n<td>${escapeHtml(source)}</td>\n<td>${e.properties?.latency_ms ?? "-"}</td>\n</tr>`;
    }).join("")
    : '<tr><td colspan="6">Nenhuma atividade encontrada.</td></tr>';

  const typeSummary = $("eventTypeSummary");
  if (typeSummary) {
    const counts = {};
    for (const e of sorted) counts[e.event_type || "-"] = (counts[e.event_type || "-"] || 0) + 1;
    const topTypes = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    typeSummary.innerHTML = topTypes.length
      ? topTypes.map(([type, count]) => `<span class="pill">${escapeHtml(type)}: ${count}</span>`).join("")
      : '<span class="pill">Sem tipos registrados</span>';
  }

  const prevBtn = $("eventsPrevBtn");
  const nextBtn = $("eventsNextBtn");
  if (prevBtn) prevBtn.disabled = state.eventsPage <= 1;
  if (nextBtn) nextBtn.disabled = state.eventsPage >= totalPages;
}

function scrollEventsTableToTop() {
  const body = $("eventsBody");
  const wrap = body?.closest(".table-wrap");
  if (wrap) wrap.scrollTop = 0;
}

function renderExperimentFeatureOptions() {
  const select = $("experimentFeatureKey");
  if (!select) return;

  const current = select.value;
  const features = Array.isArray(state.features) ? state.features : [];
  if (!features.length) {
    select.disabled = true;
    select.innerHTML = '<option value="">Carregando opções de regras...</option>';
    return;
  }

  select.disabled = false;
  select.innerHTML = [
    '<option value="">Selecione uma regra</option>',
    ...features.map((feature) => `<option value="${escapeHtml(feature.key || "")}">${escapeHtml(feature.name || feature.key || "-")} (${escapeHtml(feature.key || "-")})</option>`),
  ].join("");

  if (current && features.some((feature) => feature.key === current)) {
    select.value = current;
  }
}

function renderEventFeatureOptions() {
  const select = $("eventFeatureKey");
  if (!select) return;

  const current = select.value || $("featureKey")?.value?.trim() || "";
  const features = Array.isArray(state.features) ? state.features : [];
  if (!features.length) {
    select.disabled = true;
    select.innerHTML = '<option value="">Carregue as regras para selecionar uma</option>';
    return;
  }

  select.disabled = false;
  select.innerHTML = [
    '<option value="">Selecione uma regra</option>',
    ...features.map((feature) => `<option value="${escapeHtml(feature.key || "")}">${escapeHtml(feature.name || feature.key || "-")} (${escapeHtml(feature.key || "-")})</option>`),
  ].join("");

  if (current && features.some((feature) => feature.key === current)) {
    select.value = current;
  } else if (!select.value && features.length) {
    select.value = features[0].key || "";
  }
}

function renderExperimentMetricOptions() {
  const select = $("experimentMetricEvent");
  if (!select) return;

  const current = select.value;
  const activities = activitiesList().filter((activity) => activity.enabled !== false);

  if (!activities.length) {
    select.disabled = true;
    select.innerHTML = '<option value="">Cadastre atividades para escolher a métrica</option>';
    return;
  }

  select.disabled = false;
  select.innerHTML = [
    '<option value="">Selecione uma atividade</option>',
    ...activities.map((activity) => `<option value="${escapeHtml(activity.key || "")}">${escapeHtml(activityOptionLabel(activity))}</option>`),
  ].join("");

  if (current && activities.some((activity) => activity.key === current)) {
    select.value = current;
  } else if (!select.value && activities.length) {
    select.value = activities[0].key || "";
  }
}

async function loadActivities({ silent = false } = {}) {
  const out = await api("/activities");
  state.activities = Array.isArray(out.data) ? out.data : [];
  renderEventsTable();
  renderEvaluationTable();
  renderDashboardTables();
  renderExperimentMetricOptions();
  if (!silent) {
    markDashboardSync();
    setStatus(out.ok ? `Atividades carregadas: ${state.activities.length}` : `Erro ao carregar atividades (${out.status})`, out.data);
  }
  return out;
}

function renderExperimentsTable() {
  const body = $("experimentsBody");
  if (!body) return;

  const experiments = Array.isArray(state.experiments) ? state.experiments : [];
  setText("experimentsCount", experiments.length === 1 ? "1 teste" : `${experiments.length} testes`);

  if (!experiments.length) {
    body.innerHTML = '<tr><td colspan="7">Nenhum teste criado ainda.</td></tr>';
    renderExperimentResult();
    return;
  }

  body.innerHTML = experiments.map((experiment) => {
    const selected = Number(state.selectedExperimentId) === Number(experiment.id);
    const minSamples = formatCompactNumber(experiment.min_samples_per_variant);
    const minLift = formatPercentage(experiment.min_lift);
    return `
      <tr class="${selected ? "selected" : ""}">
        <td>${escapeHtml(experiment.name || "-")}<div class="cell-subtle">${escapeHtml(formatDateTime(experiment.created_at))}</div></td>
        <td>${escapeHtml(featureFriendlyName(experiment.feature_key))}<div class="cell-subtle">${escapeHtml(experiment.feature_key || "-")}</div></td>
        <td>${escapeHtml(activityFriendlyName(experiment.primary_metric_event))}<div class="cell-subtle">${escapeHtml(experiment.primary_metric_event || "-")}</div></td>
        <td>${minSamples} registros</td>
        <td>${minLift}</td>
        <td>${experimentStatusLabel(experiment.enabled)}</td>
        <td><button class="ghost table-action experiment-action" type="button" data-experiment-id="${escapeHtml(String(experiment.id))}">Ver resultado</button></td>
      </tr>
    `;
  }).join("");

  body.querySelectorAll(".experiment-action").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.experimentId);
      if (!Number.isFinite(id)) return;
      selectExperiment(id);
    });
  });

  renderExperimentResult();
}

function renderExperimentResult() {
  const target = $("experimentResultPreview");
  if (!target) return;

  const experiments = Array.isArray(state.experiments) ? state.experiments : [];
  const selected = experiments.find((experiment) => Number(experiment.id) === Number(state.selectedExperimentId)) || null;
  const result = state.experimentResult;

  if (!selected || !result) {
    target.innerHTML = `<div class="experiment-result-empty">${escapeHtml(state.experimentResultMessage || "Selecione um teste para visualizar o resultado.")}</div>`;
    return;
  }

  const variantA = result.variant_stats?.A || {};
  const variantB = result.variant_stats?.B || {};
  const userStatsA = result.user_stats?.A || {};
  const userStatsB = result.user_stats?.B || {};
  const samplesA = Number(variantA.samples || 0);
  const samplesB = Number(variantB.samples || 0);
  const usersA = Number(userStatsA.users || 0);
  const usersB = Number(userStatsB.users || 0);
  const positivesA = Number(variantA.positives || 0);
  const positivesB = Number(variantB.positives || 0);
  const rateA = samplesA ? positivesA / samplesA : 0;
  const rateB = samplesB ? positivesB / samplesB : 0;
  const lift = Number(result.lift_b_vs_a || 0);

  target.innerHTML = `
    <div class="experiment-result-summary">
      <div class="experiment-result-main">
        ${experimentStatusLabel(selected.enabled)}
        <div class="experiment-result-title">
          <strong>${escapeHtml(selected.name || "Teste")}</strong>
          <span>${escapeHtml(featureFriendlyName(selected.feature_key))} • ${escapeHtml(activityFriendlyName(selected.primary_metric_event))}</span>
        </div>
        <p class="experiment-result-summary-note">Comparação entre usuários únicos das variantes A e B.</p>
      </div>
      <span class="pill ${experimentDecisionTone(result.decision)}">${escapeHtml(decisionLabel(result.decision))}</span>
    </div>

    <div class="experiment-user-grid">
      <article class="experiment-user-card">
        <span>Usuários A</span>
        <strong>${formatCompactNumber(usersA)}</strong>
        <p>Usuários únicos atribuídos à variante A.</p>
      </article>
      <article class="experiment-user-card">
        <span>Usuários B</span>
        <strong>${formatCompactNumber(usersB)}</strong>
        <p>Usuários únicos atribuídos à variante B.</p>
      </article>
    </div>

    <div class="experiment-result-grid">
      <article class="experiment-stat-card">
        <span>Eventos A</span>
        <strong>${formatPercentage(rateA)}</strong>
      </article>
      <article class="experiment-stat-card">
        <span>Eventos B</span>
        <strong>${formatPercentage(rateB)}</strong>
      </article>
      <article class="experiment-stat-card">
        <span>Diferença entre B e A</span>
        <strong>${formatSignedPercentage(lift)}</strong>
      </article>
      <article class="experiment-stat-card">
        <span>Diferença mínima para decidir</span>
        <strong>${formatPercentage(result.min_lift)}</strong>
      </article>
    </div>

    <div class="experiment-variant-grid">
      <article class="experiment-variant-card">
        <span>Variante A</span>
        <strong>${formatCompactNumber(samplesA)} registros</strong>
        <p>${formatCompactNumber(positivesA)} com sucesso • taxa ${formatPercentage(rateA)}</p>
      </article>
      <article class="experiment-variant-card">
        <span>Variante B</span>
        <strong>${formatCompactNumber(samplesB)} registros</strong>
        <p>${formatCompactNumber(positivesB)} com sucesso • taxa ${formatPercentage(rateB)}</p>
      </article>
    </div>

    <p class="experiment-result-note">${escapeHtml(experimentDecisionMessage(result.decision, result))} A leitura considera usuários únicos por variante e seus eventos associados. Mínimo de ${formatCompactNumber(result.min_samples_per_variant)} registros por variante.</p>
  `;
}

async function loadExperimentResult(experimentId, { silent = false } = {}) {
  const selected = Number(experimentId);
  if (!Number.isFinite(selected)) return;

  state.selectedExperimentId = selected;
  localStorage.setItem("adaptiveFlags.experimentId", String(selected));
  state.experimentResult = null;
  state.experimentResultMessage = "Carregando resumo...";
  renderExperimentsTable();

  const out = await api(`/experiments/${selected}/result`);
  if (out.ok) {
    state.experimentResult = out.data;
    state.experimentResultMessage = "Resultado carregado.";
    renderExperimentResult();
    return;
  }

  state.experimentResult = null;
  state.experimentResultMessage = `Não foi possível carregar o resumo (${out.status}).`;
  renderExperimentResult();
  if (!silent) {
    setStatus(`Erro ao carregar resultado do teste (${out.status})`, out.data);
  }
}

async function selectExperiment(experimentId, { silent = false } = {}) {
  await loadExperimentResult(experimentId, { silent });
}

function buildTimeline() {
  const bucket = {};
  for (const e of state.events) {
    const dt = new Date(e.timestamp);
    if (Number.isNaN(dt.getTime())) continue;
    const key = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    bucket[key] = (bucket[key] || 0) + 1;
  }
  const labels = Object.keys(bucket).sort();
  const values = labels.map((k) => bucket[k]);
  return { labels, values };
}

function drawCharts() {
  if (typeof Chart === "undefined") return;
  const palette = { blue: "#0d67e8", green: "#0f8a52", red: "#cb3748", amber: "#b07a19", gray: "#72839f" };
  const isCompactViewport = window.matchMedia("(max-width: 720px)").matches;
  const m = metricsFromEvaluations();

  if (state.charts.release) state.charts.release.destroy();
  state.charts.release = new Chart($("releaseChart"), {
    type: "doughnut",
    data: { labels: ["Liberados", "Bloqueados"], datasets: [{ data: [m.enabled, m.disabled], backgroundColor: [palette.green, palette.red], borderWidth: 0 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "68%",
      layout: { padding: 0 },
      plugins: {
        legend: {
          position: isCompactViewport ? "bottom" : "right",
          labels: {
            usePointStyle: true,
            boxWidth: 10,
            boxHeight: 10,
            font: { size: isCompactViewport ? 11 : 12, weight: "600" },
          },
        },
      },
    },
  });

  if (state.charts.source) state.charts.source.destroy();
  state.charts.source = new Chart($("sourceChart"), {
    type: "bar",
    data: {
      labels: ["Inteligente", "Gradual", "Regra pausada", "Não encontrada"],
      datasets: [{ label: "Decisões", data: [m.ml, m.rollout, m.feature_disabled, m.feature_not_found], backgroundColor: [palette.blue, palette.green, palette.amber, palette.gray], borderRadius: 6 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: 0 },
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 12, weight: "500" } } },
        y: { beginAtZero: true, ticks: { precision: 0, font: { size: 12, weight: "500" } }, grid: { color: "rgba(16,32,51,0.08)" } },
      },
    },
  });

  const timeline = buildTimeline();
  if (state.charts.timeline) state.charts.timeline.destroy();
  state.charts.timeline = new Chart($("eventsTimelineChart"), {
    type: "line",
    data: {
      labels: timeline.labels,
      datasets: [{ label: "Atividades/dia", data: timeline.values, borderColor: palette.blue, backgroundColor: "rgba(13,103,232,0.12)", fill: true, tension: 0.25, pointRadius: 3 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { precision: 0, font: { size: 12, weight: "500" } }, grid: { color: "rgba(16,32,51,0.08)" } },
      },
    },
  });
}

function configureCharts() {
  if (typeof Chart === "undefined") return;
  Chart.defaults.color = "#4c5d73";
  Chart.defaults.font.family = "\"Manrope\", sans-serif";
  Chart.defaults.plugins.tooltip.backgroundColor = "rgba(15, 23, 34, 0.94)";
  Chart.defaults.plugins.tooltip.titleColor = "#ffffff";
  Chart.defaults.plugins.tooltip.bodyColor = "#eaf1fa";
  Chart.defaults.plugins.tooltip.padding = 12;
  Chart.defaults.plugins.tooltip.cornerRadius = 10;
  Chart.defaults.plugins.tooltip.displayColors = false;
  Chart.defaults.elements.line.borderWidth = 2;
  Chart.defaults.elements.point.radius = 3;
  Chart.defaults.elements.point.hoverRadius = 4;
}

function featurePayload() {
  const description = $("featureDescription").value.trim();
  return {
    name: $("featureName").value.trim(),
    key: $("featureKey").value.trim(),
    description: description || null,
    enabled: $("enabled").checked,
    rollout_percentage: normalizeNumber($("rollout").value, 0),
    ml_enabled: $("thresholdMode").value !== "fixed",
    ml_threshold_mode: $("thresholdMode").value,
    ml_threshold_value: normalizeNumber($("thresholdValue").value, 0.1),
  };
}

async function upsertFeature() {
  const release = setLoading("upsertFeatureBtn", "Salvando...");
  try {
    const payload = featurePayload();
    if (!payload.name || !payload.key) {
      setStatus("Informe o nome e o identificador da regra.");
      setActionStatus("featureActionStatus", "Informe o nome e o identificador da regra.", "bad");
      return;
    }
    const list = await api("/features");
    if (!list.ok || !Array.isArray(list.data)) {
      setStatus(`Erro ao consultar regras (${list.status})`, list.data);
      setActionStatus("featureActionStatus", `Erro ao consultar regras (${list.status})`, "bad");
      return;
    }
    const existing = list.data.find((f) => f.key === payload.key);
    const out = existing
      ? await api(`/features/${existing.id}`, { method: "PUT", body: JSON.stringify(payload) })
      : await api("/features", { method: "POST", body: JSON.stringify(payload) });

    if (out.ok) {
      const refreshed = await api("/features");
      state.features = Array.isArray(refreshed.data) ? refreshed.data : state.features;
      updateMetricCards();
      renderFeaturesTable();
      renderEvaluationTable();
      renderExperimentFeatureOptions();
      renderEventFeatureOptions();
      renderDashboardTables();
      markDashboardSync();
    }

    if (out.status === 405) {
      const message = out.data?.detail || "Esta publicação é somente leitura.";
      setStatus(message, out.data);
      setActionStatus("featureActionStatus", message, "bad");
      return;
    }

    if (out.status === 401) {
      const message = "Salvar regra exige autenticação. Gere um JWT em /auth/token e salve-o como adaptiveFlags.token no navegador.";
      setStatus(message, out.data);
      setActionStatus("featureActionStatus", message, "bad");
      return;
    }

    const message = out.ok ? `Regra salva em ${out.elapsed}ms.` : `Erro ao salvar regra (${out.status})`;
    setStatus(message, out.data);
    setActionStatus("featureActionStatus", message, out.ok ? "ok" : "bad");
  } finally { release(); }
}

async function listFeatures(btnId = "loadFeaturesBtnFeature") {
  const release = setLoading(btnId, "Carregando...");
  try {
    const out = await api("/features");
    state.features = Array.isArray(out.data) ? out.data : [];
    updateMetricCards();
    renderFeaturesTable();
    renderEvaluationTable();
    renderExperimentFeatureOptions();
    renderEventFeatureOptions();
    renderDashboardTables();
    markDashboardSync();
    setStatus(out.ok ? `Regras carregadas: ${state.features.length}` : `Erro ao carregar regras (${out.status})`, out.data);
  } finally { release(); }
}

async function runHealth() {
  const release = setLoading("healthBtn", "Testando...");
  try {
    const out = await api("/health");
    if (out.ok) markDashboardSync();
    setStatus(out.ok ? `Sistema disponível em ${out.elapsed}ms` : `Erro ao verificar o sistema (${out.status})`, out.data);
  } finally { release(); }
}

async function loadMetrics() {
  const release = setLoading("metricsBtn", "Carregando...");
  try {
    const out = await api("/metrics");
    if (out.ok) markDashboardSync();
    setStatus(out.ok ? `Métricas carregadas em ${out.elapsed}ms` : `Erro ao carregar métricas (${out.status})`, out.data);
  } finally { release(); }
}

async function loadEvaluations(limit = 1000) {
  try {
    const params = new URLSearchParams({ limit: String(limit) });
    const out = await api(`/evaluations?${params.toString()}`);
    state.evaluations = Array.isArray(out.data) ? out.data : [];
    updateMetricCards();
    renderEvaluationTable();
    renderDashboardTables();
    drawCharts();
    if (out.ok) {
      return;
    }
    setStatus(`Erro ao carregar avaliações (${out.status})`, out.data);
  } catch (error) {
    setStatus("Erro ao carregar avaliações.", String(error));
  }
}

async function trainModel() {
  const release = setLoading("trainBtn", "Treinando...");
  try {
    const out = await api("/train", { method: "POST", body: JSON.stringify({}) });
    if (out.status === 405) {
      const message = out.data?.detail || "Esta publicação é somente leitura.";
      setStatus(message, out.data);
      setModelStatus(message, out.data);
      setActionStatus("trainActionStatus", message, "bad");
      return;
    }
    if (out.status === 401) {
      const message = "Treino exige autenticação. Gere um JWT em /auth/token e salve-o como adaptiveFlags.token no navegador.";
      setStatus(message, out.data);
      setModelStatus(message, out.data);
      setActionStatus("trainActionStatus", message, "bad");
      return;
    }

    const message = out.ok ? `Treinamento concluído em ${out.elapsed}ms` : `Erro no treinamento (${out.status})`;
    setStatus(message, out.data);
    setModelStatus(message, out.data);
    setActionStatus("trainActionStatus", message, out.ok ? "ok" : "bad");
    if (out.ok) {
      state.modelStatus = out.data;
      await loadModelRuns(5, { silent: true });
      markDashboardSync();
      updateDashboardSummary();
    }
  } finally { release(); }
}

async function loadModelStatus() {
  const release = () => {};
  try {
    const out = await api("/model/status");
    setStatus(out.ok ? "Situação do modelo carregada." : `Erro ao carregar a situação do modelo (${out.status})`, out.data);
    setModelStatus(out.ok ? "Situação do modelo carregada." : `Erro ao carregar a situação do modelo (${out.status})`, out.data);
    if (out.ok) {
      state.modelStatus = out.data;
      markDashboardSync();
      updateDashboardSummary();
    }
  } finally { release(); }
}

async function loadModelRuns(limit = 5, { silent = false } = {}) {
  const release = () => {};
  try {
    const out = await api(`/model/runs?limit=${limit}`);
    const runs = Array.isArray(out.data) ? out.data : Array.isArray(out.data?.runs) ? out.data.runs : [];
    state.modelRuns = runs;
    renderModelRuns();
    renderModelStatus();
    if (out.ok) {
      markDashboardSync();
      updateDashboardSummary();
    } else {
      setStatus(`Erro ao carregar histórico de treinamentos (${out.status})`, out.data);
    }
  } finally { release(); }
}

async function evaluateUsers() {
  const release = setLoading("simulateBtn", "Avaliando...");
  try {
    const users = $("users").value.split("\n").map((u) => u.trim()).filter(Boolean);
    if (!users.length) {
      setStatus("Informe ao menos um usuário.");
      setActionStatus("evaluationActionStatus", "Informe ao menos um usuário.", "bad");
      return;
    }

    const output = [];
    for (const userId of users) {
      const featureKeys = await resolveEvaluationFeatureKeys(userId);
      if (!featureKeys.length) {
        output.push({ user_id: userId, feature_key: "-", enabled: false, decision_source: "feature_not_found" });
        continue;
      }

      for (const featureKey of featureKeys) {
        const out = await api("/evaluate", {
          method: "POST",
          body: JSON.stringify({ feature_key: featureKey, user: { user_id: userId } }),
        });
        if (out.status === 405) {
          const message = out.data?.detail || "Esta publicação é somente leitura.";
          setStatus(message, out.data);
          setActionStatus("evaluationActionStatus", message, "bad");
          return;
        }
        if (out.status === 401) {
          const message = "Avaliar usuários exige autenticação. Gere um JWT em /auth/token e salve-o como adaptiveFlags.token no navegador.";
          setStatus(message, out.data);
          setActionStatus("evaluationActionStatus", message, "bad");
          return;
        }
        output.push(out.ok ? out.data : { user_id: userId, feature_key: featureKey, enabled: false, decision_source: `error_${out.status}` });
      }
    }

    if (output.length) {
      const latest = new Set(output.map((row) => `${row.user_id}:${row.feature_key}`));
      state.evaluations = [...output, ...state.evaluations.filter((row) => !latest.has(`${row.user_id}:${row.feature_key}`))];
    }
    updateMetricCards();
    renderEvaluationTable();
    drawCharts();
    markDashboardSync();
    renderDashboardTables();
    const message = `Avaliação concluída para ${users.length} usuários e ${output.length} regras.`;
    setStatus(message);
    setActionStatus("evaluationActionStatus", message, "ok");
    await loadEvaluations();
  } finally { release(); }
}

async function clearEvaluations() {
  const release = setLoading("clearEvaluationsBtn", "Limpando...");
  try {
    const out = await api("/evaluations", { method: "DELETE" });
    if (out.status === 405) {
      const message = out.data?.detail || "Esta publicação é somente leitura.";
      setStatus(message, out.data);
      setActionStatus("evaluationActionStatus", message, "bad");
      return;
    }
    if (out.ok) {
      state.evaluations = [];
      updateMetricCards();
      renderEvaluationTable();
      drawCharts();
      markDashboardSync();
      renderDashboardTables();
      setStatus("Avaliações limpas.");
      await loadEvaluations();
      return;
    }
    setStatus(`Erro ao limpar avaliações (${out.status})`, out.data);
  } finally {
    release();
  }
}

function operationalMetrics() {
  const out = {};
  const latency = normalizeNumber($("latencyMs")?.value);
  const errorRate = normalizeNumber($("errorRate")?.value);
  if (latency !== null) out.latency_ms = latency;
  if (errorRate !== null) out.error_rate = errorRate;
  return out;
}

function ingestCount() {
  const raw = normalizeNumber($("ingestCount").value, 1);
  const count = Number.isFinite(raw) ? Math.floor(raw) : 1;
  return Math.max(1, Math.min(5000, count));
}

async function sendEvent() {
  const batchCount = ingestCount();
  const release = setLoading("sendEventBtn", batchCount > 1 ? "Enviando lote..." : "Enviando...");
  try {
    const featureKeyInput = $("eventFeatureKey").value.trim();
    const featureKey = featureKeyInput || $("eventActivityKey").value.trim();
    const userId = $("eventUserId").value.trim();
    const activityKey = $("eventActivityKey").value.trim();
    const activityName = $("eventActivityName").value.trim();
    const source = $("eventSource").value.trim() || "ui_manual";
    if (!featureKey || !userId || !activityKey) {
      setEventStatus("Informe o usuário e o identificador da atividade.", "bad");
      return;
    }

    if ($("eventFeatureKey") && !featureKeyInput) {
      $("eventFeatureKey").value = featureKey;
    }

    const baseEvent = {
      user_id: userId,
      feature_key: featureKey,
      event_type: activityKey,
      timestamp: new Date().toISOString(),
      properties: {
        ...operationalMetrics(),
        activity_name: activityName || null,
      },
    };

    const optimisticEvent = batchCount === 1
      ? {
        id: `temp-${Date.now()}`,
        source,
        ...baseEvent,
      }
      : null;

    if (optimisticEvent) {
      state.events = [optimisticEvent, ...state.events];
      state.eventsPage = 1;
      renderEventsTable();
      scrollEventsTableToTop();
      updateMetricCards();
      drawCharts();
      markDashboardSync();
      renderDashboardTables();
    }

    const out = batchCount === 1
      ? await api("/events", { method: "POST", body: JSON.stringify({ ...baseEvent, source }) })
      : await api("/ingest/events", {
        method: "POST",
        body: JSON.stringify({
          source,
          events: Array.from({ length: batchCount }, (_, index) => ({
            ...baseEvent,
            timestamp: new Date(Date.now() + index).toISOString(),
          })),
        }),
      });

    if (out.status === 405) {
      const message = out.data?.detail || "Esta publicação é somente leitura.";
      setStatus(message, out.data);
      setEventStatus(message, "bad");
      return;
    }

    if (out.status === 401) {
      const message = "Registrar atividade exige autenticação. Gere um JWT em /auth/token e salve-o como adaptiveFlags.token no navegador.";
      setStatus(message, out.data);
      setEventStatus(message, "bad");
      return;
    }

    const message = out.ok
      ? (batchCount === 1 ? "Registro concluído." : `Registros concluídos em lote: ${batchCount}.`)
      : `Erro ao registrar atividade (${out.status})`;
    setStatus(message, out.data);
    setEventStatus(message, out.ok ? "ok" : "bad");
    if (out.ok) {
      if (batchCount === 1 && out.data) {
        state.events = [
          out.data,
          ...state.events.filter((event) => String(event.id) !== String(out.data.id) && !String(event.id).startsWith("temp-")),
        ];
        state.eventsFilter = "";
        const filterInput = $("eventsFilter");
        if (filterInput) filterInput.value = "";
        renderEventsTable();
        scrollEventsTableToTop();
        updateMetricCards();
        drawCharts();
        markDashboardSync();
        renderDashboardTables();
      }
      else {
        await loadEventsFromDb("loadEventsBtn");
      }
      return;
    }

    if (optimisticEvent) {
      state.events = state.events.filter((event) => event.id !== optimisticEvent.id);
      renderEventsTable();
      scrollEventsTableToTop();
      updateMetricCards();
      drawCharts();
      markDashboardSync();
      renderDashboardTables();
    }
  } finally { release(); }
}

async function loadEventsFromDb(btnId = "loadEventsBtn") {
  const release = setLoading(btnId, "Carregando...");
  try {
    const out = await api("/events");
    if (!out.ok || !Array.isArray(out.data)) {
      setStatus(`Erro ao carregar atividades (${out.status})`, out.data);
      return;
    }

    state.events = out.data;
    state.eventsPage = 1;
    renderEventsTable();
    scrollEventsTableToTop();
    updateMetricCards();
    drawCharts();
    markDashboardSync();
    renderDashboardTables();
    setStatus(`Atividades carregadas: ${state.events.length}`);
  } finally { release(); }
}

async function loadExperiments() {
  const release = () => {};
  try {
    const out = await api("/experiments");
    state.experiments = Array.isArray(out.data) ? out.data : [];
    state.experimentsCount = state.experiments.length;
    updateDashboardSummary();
    renderExperimentsTable();
    if (out.ok) markDashboardSync();
    renderDashboardTables();
    const selected = state.experiments.find((experiment) => Number(experiment.id) === Number(state.selectedExperimentId)) || state.experiments[0] || null;
    if (selected) {
      state.selectedExperimentId = selected.id;
      localStorage.setItem("adaptiveFlags.experimentId", String(selected.id));
      await loadExperimentResult(selected.id, { silent: true });
    } else {
      state.experimentResult = null;
      state.experimentResultMessage = "Nenhum teste criado ainda.";
      renderExperimentResult();
    }
    setStatus(out.ok ? `Testes carregados: ${state.experiments.length}` : `Erro ao carregar testes (${out.status})`, out.data);
  } finally { release(); }
}

function experimentPayload() {
  const minSamples = Math.max(1, Math.floor(normalizeNumber($("experimentMinSamples").value, 100) || 100));
  const minLift = normalizeNumber($("experimentMinLift").value, 0.02);
  return {
    name: $("experimentName").value.trim(),
    feature_key: $("experimentFeatureKey").value.trim(),
    primary_metric_event: $("experimentMetricEvent").value.trim(),
    min_samples_per_variant: minSamples,
    min_lift: Number.isFinite(minLift) ? minLift : 0.02,
    enabled: $("experimentEnabled").checked,
  };
}

async function createExperiment() {
  const release = setLoading("createExperimentBtn", "Criando...");
  try {
    const payload = experimentPayload();
    if (!payload.name || !payload.feature_key || !payload.primary_metric_event) {
      setStatus("Informe nome, regra e atividade principal do teste.");
      setActionStatus("experimentActionStatus", "Informe nome, regra e atividade principal do teste.", "bad");
      return;
    }

    const out = await api("/experiments", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (!out.ok) {
      if (out.status === 405) {
        const message = out.data?.detail || "Esta publicação é somente leitura.";
        setStatus(message, out.data);
        setActionStatus("experimentActionStatus", message, "bad");
        return;
      }
      if (out.status === 401) {
        const message = "Criar teste exige autenticação. Gere um JWT em /auth/token e salve-o como adaptiveFlags.token no navegador.";
        setStatus(message, out.data);
        setActionStatus("experimentActionStatus", message, "bad");
        return;
      }
      const message = `Erro ao criar teste (${out.status})`;
      setStatus(message, out.data);
      setActionStatus("experimentActionStatus", message, "bad");
      return;
    }

    const message = `Teste criado em ${out.elapsed}ms.`;
    setStatus(message, out.data);
    setActionStatus("experimentActionStatus", message, "ok");
    if (out.data?.id) {
      state.selectedExperimentId = out.data.id;
      localStorage.setItem("adaptiveFlags.experimentId", String(out.data.id));
    }
    await loadExperiments();
  } finally { release(); }
}

function bind() {
  const pendingSpinnerAdjustments = new WeakMap();
  const on = (id, fn) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("click", async () => {
      try { await fn(); } catch (error) { setStatus(`Erro na ação ${id}`, String(error)); }
    });
  };

  on("healthBtn", runHealth);
  on("metricsBtn", loadMetrics);
  on("upsertFeatureBtn", upsertFeature);
  on("createExperimentBtn", createExperiment);
  on("trainBtn", trainModel);
  on("simulateBtn", evaluateUsers);
  on("clearEvaluationsBtn", clearEvaluations);
  on("sendEventBtn", sendEvent);
  on("eventsPrevBtn", () => {
    state.eventsPage = Math.max(1, state.eventsPage - 1);
    renderEventsTable();
  });
  on("eventsNextBtn", () => {
    state.eventsPage += 1;
    renderEventsTable();
  });
  on("copyStatusBtn", async () => {
    try {
      await navigator.clipboard.writeText(state.lastStatusPayload || "Sem detalhes disponíveis.");
      setStatus("Detalhes copiados para a área de transferência.", state.lastStatusPayload);
    } catch (error) {
      setStatus("Não foi possível copiar os detalhes.", String(error));
    }
  });
  on("clearStatusBtn", () => {
    state.lastStatusPayload = "Sem detalhes disponíveis.";
    state.statusHistory = [];
    const summary = $("apiStatusSummary");
    const meta = $("apiStatusMeta");
    const payload = $("apiStatusPayload");
    const history = $("statusHistory");
    if (summary) summary.textContent = "Pronto.";
    if (meta) meta.textContent = "Sem atividade recente.";
    if (payload) payload.textContent = "Sem detalhes disponíveis.";
    if (history) history.innerHTML = "";
  });
  const featureFilter = $("featureFilter");
  if (featureFilter) {
    featureFilter.addEventListener("input", () => {
      state.featureFilter = featureFilter.value;
      renderFeaturesTable();
      renderDashboardTables();
    });
  }
  const eventsFilter = $("eventsFilter");
  if (eventsFilter) {
    eventsFilter.addEventListener("input", () => {
      state.eventsFilter = eventsFilter.value;
      state.eventsPage = 1;
      renderEventsTable();
    });
  }
  const eventsPerPage = $("eventsPerPage");
  if (eventsPerPage) {
    eventsPerPage.addEventListener("change", () => {
      state.eventsPage = 1;
      renderEventsTable();
    });
  }
  document.querySelectorAll(".nav-item[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.page;
      requestAnimationFrame(() => setPage(next));
    });
  });
  document.querySelectorAll('input[type="number"]').forEach((input) => {
    input.addEventListener("blur", () => normalizeNumberField(input));
    input.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = input.getBoundingClientRect();
      const spinnerWidth = Math.min(28, rect.width * 0.18);
      if (event.clientX < rect.right - spinnerWidth) return;
      const direction = event.clientY < (rect.top + rect.bottom) / 2 ? 1 : -1;
      pendingSpinnerAdjustments.set(input, {
        direction,
        before: input.value,
      });
    });
    input.addEventListener("click", () => {
      const pending = pendingSpinnerAdjustments.get(input);
      if (!pending) return;
      requestAnimationFrame(() => {
        if (input.value === pending.before) {
          stepNumberField(input, pending.direction);
        }
        pendingSpinnerAdjustments.delete(input);
      });
    });
  });
  window.addEventListener("hashchange", () => setPage(window.location.hash.replace(/^#/, ""), { fromHash: true }));
}

function init() {
  const baseUrlInput = $("baseUrl");
  if (baseUrlInput && !baseUrlInput.value.trim()) {
    baseUrlInput.value = window.location.origin;
  }
  configureCharts();
  const chartScript = $("chartJs");
  if (chartScript && typeof Chart === "undefined") {
    chartScript.addEventListener("load", () => {
      configureCharts();
      drawCharts();
    }, { once: true });
  }
  bind();
  setPage(window.location.hash.replace(/^#/, "") || state.page, { fromHash: Boolean(window.location.hash) });
  updateMetricCards();
  updateDashboardSummary();
  renderFeaturesTable();
  renderEvaluationTable();
  renderEventsTable();
  renderExperimentFeatureOptions();
  renderEventFeatureOptions();
  renderExperimentsTable();
  renderModelStatus();
  renderModelRuns();
  drawCharts();
  if (typeof Chart === "undefined") {
    setStatus("Os gráficos não carregaram, mas o restante do painel continua disponível.");
  }
  Promise.allSettled([
    loadActivities({ silent: true }),
    listFeatures("loadFeaturesBtnFeature"),
    loadEventsFromDb("loadEventsBtn"),
    loadEvaluations(),
    loadModelStatus(),
    loadModelRuns(5, { silent: true }),
    loadExperiments(),
  ]).finally(() => drawCharts());
}

window.sendEvent = sendEvent;

document.addEventListener("DOMContentLoaded", init);
