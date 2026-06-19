import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import Papa from "papaparse";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from "recharts";

const TEMPS = {
  "-10C": { color: "#5B8FF9", label: "-10C" },
  "0C":   { color: "#FF7B54", label: "0C"   },
  "10C":  { color: "#00D2A0", label: "10C"  },
  "25C":  { color: "#A855F7", label: "25C"  },
};

const DRIVE_CYCLES = [
  { code: "UDDS",  label: "UDDS",  desc: "Urban Dynamometer Driving Schedule – city stop-and-go" },
  { code: "HWFET", label: "HWFET", desc: "Highway Fuel Economy Test – steady highway driving" },
  { code: "US06",  label: "US06",  desc: "Supplemental FTP – aggressive high-speed driving" },
  { code: "WLTP",  label: "WLTP",  desc: "Worldwide Harmonised Light Vehicles Test Procedure" },
];

const SIGNALS = [
  { key: "Voltage", label: "Voltage", unit: "V", decimals: 2 },
  { key: "Current", label: "Current", unit: "A", decimals: 2 },
  { key: "Power",   label: "Power",   unit: "W", decimals: 2 },
  { key: "SOC",     label: "SOC",     unit: "%", decimals: 3 },
];

const WIN_PRESETS = [2, 5, 10];

function parseTime(str) {
  if (!str) return null;
  const text = String(str).trim();
  const [m, s] = text.split(":");
  if (m == null || s == null) return null;
  return parseFloat(m) * 60 + parseFloat(s);
}

function fmtTick(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtTime(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function normalizeNumber(value) {
  const num = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(num) ? num : NaN;
}

function downsample(rows, n = 500) {
  if (rows.length <= n) return rows;
  const step = Math.ceil(rows.length / n);
  return rows.filter((_, i) => i % step === 0);
}

function buildChart(allTemps, activeTemps, sig, startSec, endSec, maxPts = 500) {
  const merged = {};
  for (const [tk, rows] of Object.entries(allTemps)) {
    if (!activeTemps[tk] || !rows?.length) continue;
    const win = rows.filter(r => r._t >= startSec && r._t <= endSec);
    for (const r of downsample(win, maxPts)) {
      const t = Math.round(r._t * 2) / 2;
      if (!merged[t]) merged[t] = { _t: t };
      merged[t][tk] = r[sig];
    }
  }
  return Object.values(merged).sort((a, b) => a._t - b._t);
}

function calcStats(rows, sig, dec) {
  const vals = rows.map(r => r[sig]).filter(v => v != null && !isNaN(v));
  if (!vals.length) return { min: "—", avg: "—", max: "—" };
  return {
    min: Math.min(...vals).toFixed(dec),
    avg: (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(dec),
    max: Math.max(...vals).toFixed(dec),
  };
}

function guessTempFromPath(path) {
  if (!path) return null;
  const safePath = path.replace(/\\/g, "/");
  const segments = safePath.split("/").filter(Boolean);
  if (segments.length < 1) return null;
  const folder = segments[0].trim();
  return Object.keys(TEMPS).find(key => key.toLowerCase() === folder.toLowerCase()) || null;
}

function guessTempFromName(name) {
  if (!name) return null;
  const match = name.match(/(-?\d{1,2}C)/i);
  if (!match) return null;
  const temp = match[1].toUpperCase();
  return Object.keys(TEMPS).includes(temp) ? temp : null;
}

function parseCodeFromName(name) {
  const base = name.replace(/\.csv$/i, "");
  const parts = base.split("_");
  return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : base.toUpperCase();
}

function normalizeRow(row) {
  const timeValue = row["Step Time"] ?? row["step time"] ?? row["Time"] ?? row["time"];
  const voltage = normalizeNumber(row.Voltage);
  const current = normalizeNumber(row.Current);
  const power = normalizeNumber(row.Power);
  return {
    ...row,
    Voltage: voltage,
    Current: current,
    SOC: normalizeNumber(row.SOC),
    Temperature: normalizeNumber(row.Temperature),
    Power: Number.isFinite(power) ? power : voltage * current,
    _t: parseTime(timeValue),
  };
}

const TTip = ({ active, payload, label, unit, dec }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 6, padding: "8px 12px", fontSize: 12 }}>
      <div style={{ color: "#8b9ab5", marginBottom: 4 }}>⏱ {fmtTick(label)}</div>
      {payload.map(p => (
        <div key={p.dataKey} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color, display: "inline-block" }} />
          <span style={{ color: "#8b9ab5" }}>{TEMPS[p.dataKey]?.label || p.dataKey}:</span>
          <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{Number(p.value).toFixed(dec)} {unit}</span>
        </div>
      ))}
    </div>
  );
};

export default function BatteryDashboard() {
  const [dataMap,   setDataMap]   = useState({});
  const [loading,   setLoading]   = useState(false);
  const [fileLabel, setFileLabel] = useState("No files loaded");
  const [cycle,     setCycle]     = useState("UDDS");
  const [signal,    setSignal]    = useState("Voltage");
  const [winMins,   setWinMins]   = useState(10);
  const [startMin,  setStartMin]  = useState(0);
  const [activeTmp, setActiveTmp] = useState({ "-10C": true, "0C": true, "10C": true, "25C": false });
  const fileRef = useRef(null);

  const parsedCodes = useMemo(() => Object.keys(dataMap), [dataMap]);
  const allTemps = useMemo(() => dataMap[cycle] ?? {}, [dataMap, cycle]);
  const duration = useMemo(() => {
    const allRows = Object.values(allTemps).flat();
    return allRows.length ? Math.max(...allRows.map(r => r._t)) : 0;
  }, [allTemps]);

  useEffect(() => {
    if (parsedCodes.length && !parsedCodes.includes(cycle)) {
      setCycle(parsedCodes[0]);
      setStartMin(0);
    }
  }, [parsedCodes, cycle]);

  const availableCycles = useMemo(() => {
    const codes = new Set(DRIVE_CYCLES.map(d => d.code));
    parsedCodes.forEach(code => codes.add(code));
    return Array.from(codes);
  }, [parsedCodes]);

  const maxStart = Math.max(0, Math.floor((duration - winMins * 60) / 60));
  const safeStart = Math.min(startMin, maxStart);
  const startSec = safeStart * 60;
  const endSec = startSec + winMins * 60;

  const chartData = useMemo(
    () => buildChart(allTemps, activeTmp, signal, startSec, endSec),
    [allTemps, activeTmp, signal, startSec, endSec]
  );

  const stats = useMemo(() => {
    const s = SIGNALS.find(x => x.key === signal);
    const out = {};
    for (const [tk, rows] of Object.entries(allTemps)) {
      const win = rows.filter(r => r._t >= startSec && r._t <= endSec);
      out[tk] = calcStats(win, signal, s?.decimals ?? 2);
    }
    return out;
  }, [allTemps, signal, startSec, endSec]);

  const sig = SIGNALS.find(s => s.key === signal);
  const cyc = DRIVE_CYCLES.find(c => c.code === cycle) || { label: cycle, desc: "Loaded dataset" };

  const yVals = chartData.flatMap(d => Object.keys(TEMPS).map(k => d[k]).filter(v => v != null));
  const yMin = yVals.length ? Math.min(...yVals) : 0;
  const yMax = yVals.length ? Math.max(...yVals) : 1;
  const yPad = (yMax - yMin) * 0.08 || 0.1;
  const activeTempKeys = Object.entries(activeTmp).filter(([, v]) => v).map(([k]) => k);
  const sampleInterval = chartData.length > 1 ? Math.round((endSec - startSec) / chartData.length) : 5;

  const c = {
    bg: "#0d1117",
    sidebar: "#0d1117",
    navbar: "#0d1117",
    border: "#21262d",
    border2: "#30363d",
    text: "#c9d1d9",
    muted: "#8b9ab5",
    faint: "#484f58",
    card: "#161b22",
    active: "#161b22",
    hover: "#161b22",
  };

  const parseCSVFile = useCallback(file => {
    return new Promise(resolve => {
      const relativePath = file.webkitRelativePath || file.name;
      const temperature = guessTempFromPath(relativePath) || guessTempFromName(file.name) || "-10C";
      const code = parseCodeFromName(file.name);
      Papa.parse(file, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        complete: res => {
          const rows = res.data
            .map(normalizeRow)
            .filter(r => r._t != null);
          resolve({ temperature, code, rows, filename: file.name });
        }
      });
    });
  }, []);

  const loadFiles = useCallback(async files => {
    if (!files?.length) return;
    setLoading(true);
    const fileArray = Array.from(files);
    const parsed = await Promise.all(fileArray.map(parseCSVFile));
    const map = {};
    parsed.forEach(file => {
      if (!file.rows.length) return;
      map[file.code] ??= {};
      map[file.code][file.temperature] = file.rows;
    });
    setDataMap(map);
    setFileLabel(`${fileArray.length} file(s) loaded`);
    setLoading(false);
    setStartMin(0);
  }, [parseCSVFile]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: c.bg, color: c.text, fontFamily: "'Inter','Segoe UI',system-ui,sans-serif", fontSize: 13, overflow: "hidden" }}>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", height: 48, borderBottom: `1px solid ${c.border}`, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ width: 18, height: 1.5, background: c.muted }} />
            <div style={{ width: 14, height: 1.5, background: c.muted }} />
            <div style={{ width: 18, height: 1.5, background: c.muted }} />
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", color: "#e2e8f0", textTransform: "uppercase" }}>Battery Cell Analyzer</div>
            <div style={{ fontSize: 10, color: c.faint, letterSpacing: "0.05em" }}>Drive Cycle · Temperature · Multi-Signal</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 11, color: c.muted }}>
          <span>cycle <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{cycle}</span></span>
          <span style={{ color: c.border2 }}>·</span>
          <span>signal <span style={{ color: "#e2e8f0", fontWeight: 600 }}>{sig?.label}</span> <span style={{ color: c.faint }}>({sig?.unit})</span></span>
          <span style={{ color: c.border2 }}>·</span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ color: c.faint }}>▪</span>
            {activeTempKeys.length} temp · {chartData.length} pts
          </span>
          <button
            onClick={() => fileRef.current?.click()}
            style={{ padding: "4px 12px", fontSize: 11, background: "transparent", border: `1px solid ${c.border2}`, borderRadius: 4, color: c.muted, cursor: "pointer" }}
          >
            {loading ? "Loading…" : "Load folders / files"}
          </button>
          <input ref={fileRef} type="file" accept=".csv" multiple webkitdirectory style={{ display: "none" }} onChange={e => loadFiles(e.target.files)} />
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>

        <div style={{ width: 200, borderRight: `1px solid ${c.border}`, display: "flex", flexDirection: "column", overflowY: "auto", flexShrink: 0 }}>

          <div style={{ padding: "14px 14px 6px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: c.muted, textTransform: "uppercase", marginBottom: 8, display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ fontSize: 12 }}>⚡</span> Temperature
            </div>
            {Object.entries(TEMPS).map(([tk, tv]) => {
              const on = activeTmp[tk];
              const has = Boolean(allTemps[tk]?.length);
              return (
                <div
                  key={tk}
                  onClick={() => has && setActiveTmp(p => ({ ...p, [tk]: !p[tk] }))}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "6px 10px", borderRadius: 5, cursor: has ? "pointer" : "not-allowed", marginBottom: 3,
                    background: on ? `${tv.color}18` : "transparent",
                    border: `1px solid ${on ? tv.color + "40" : "transparent"}`,
                    opacity: has ? 1 : 0.45,
                    transition: "all 0.15s",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <div style={{ width: 8, height: 8, borderRadius: "50%", background: on ? tv.color : c.faint, transition: "background 0.15s" }} />
                    <span style={{ color: on ? "#e2e8f0" : c.faint, fontWeight: on ? 500 : 400 }}>{tk}</span>
                  </div>
                  <span style={{
                    fontSize: 9, padding: "1px 6px", borderRadius: 3,
                    border: `1px solid ${on ? tv.color + "60" : c.border2}`,
                    color: on ? tv.color : c.faint,
                    background: on ? `${tv.color}18` : "transparent",
                  }}>{has ? (on ? "on" : "off") : "missing"}</span>
                </div>
              );
            })}
          </div>

          <div style={{ height: 1, background: c.border, margin: "4px 0" }} />

          <div style={{ padding: "12px 14px 6px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: c.muted, textTransform: "uppercase", marginBottom: 8, display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ fontSize: 12 }}>⚡</span> Drive Cycle
            </div>
            {availableCycles.map(code => {
              const active = cycle === code;
              const info = DRIVE_CYCLES.find(d => d.code === code);
              return (
                <div
                  key={code}
                  onClick={() => setCycle(code)}
                  style={{
                    padding: "7px 10px", borderRadius: 5, cursor: "pointer", marginBottom: 3,
                    background: active ? "rgba(0,210,160,0.08)" : "transparent",
                    borderLeft: `2px solid ${active ? "#00D2A0" : "transparent"}`,
                    color: active ? "#00D2A0" : c.muted,
                    fontWeight: active ? 600 : 400,
                    transition: "all 0.12s",
                    display: "flex", alignItems: "center", gap: 7,
                  }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: active ? "#00D2A0" : c.faint, flexShrink: 0 }} />
                  {info?.label ?? code}
                </div>
              );
            })}
            <p style={{ fontSize: 10, color: c.faint, margin: "6px 2px 0", lineHeight: 1.5 }}>{cyc.desc}</p>
          </div>

          <div style={{ height: 1, background: c.border, margin: "4px 0" }} />

          <div style={{ padding: "12px 14px 6px" }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: c.muted, textTransform: "uppercase", marginBottom: 8, display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ fontSize: 12 }}>⚡</span> Signal
            </div>
            {SIGNALS.map(s => {
              const active = signal === s.key;
              return (
                <div
                  key={s.key}
                  onClick={() => setSignal(s.key)}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "7px 10px", borderRadius: 5, cursor: "pointer", marginBottom: 3,
                    background: active ? "rgba(91,143,249,0.1)" : "transparent",
                    color: active ? "#5B8FF9" : c.muted,
                    fontWeight: active ? 600 : 400,
                    transition: "all 0.12s",
                  }}
                >
                  <span>{s.label}</span>
                  <span style={{ fontSize: 10, color: active ? "#5B8FF940" : c.faint }}>{s.unit}</span>
                </div>
              );
            })}
          </div>

          <div style={{ height: 1, background: c.border, margin: "4px 0" }} />

          <div style={{ padding: "12px 14px", marginTop: "auto" }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: c.muted, textTransform: "uppercase", marginBottom: 10, display: "flex", alignItems: "center", gap: 5 }}>
              <span>○</span> Time Window
            </div>
            <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
              {WIN_PRESETS.map(w => (
                <button
                  key={w}
                  onClick={() => setWinMins(w)}
                  style={{
                    flex: 1, padding: "5px 0", fontSize: 11,
                    border: `1px solid ${winMins === w ? "#00D2A0" : c.border2}`,
                    borderRadius: 4,
                    background: winMins === w ? "rgba(0,210,160,0.12)" : "transparent",
                    color: winMins === w ? "#00D2A0" : c.muted,
                    cursor: "pointer", fontWeight: winMins === w ? 600 : 400,
                    transition: "all 0.12s",
                  }}
                >{w} min</button>
              ))}
            </div>

            <div style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: c.muted, marginBottom: 5 }}>
                <span style={{ fontWeight: 600, letterSpacing: "0.05em" }}>START</span>
                <span style={{ color: "#00D2A0", fontWeight: 600 }}>{fmtTime(safeStart * 60)}</span>
              </div>
              <input type="range" min={0} max={maxStart || 1} value={safeStart} step={1}
                onChange={e => setStartMin(Number(e.target.value))}
                style={{ width: "100%", accentColor: "#00D2A0" }} />
            </div>

            <div style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: c.muted, marginBottom: 5 }}>
                <span style={{ fontWeight: 600, letterSpacing: "0.05em" }}>END</span>
                <span style={{ color: "#00D2A0", fontWeight: 600 }}>{fmtTime(Math.min(endSec, duration))}</span>
              </div>
              <input type="range" min={1} max={Math.ceil(duration / 60) || 20} value={winMins} step={1}
                onChange={e => { setWinMins(Number(e.target.value)); }}
                style={{ width: "100%", accentColor: "#00D2A0" }} />
            </div>

            <div style={{ fontSize: 10, color: c.faint, textAlign: "center" }}>
              {fmtTime(startSec)} → {fmtTime(Math.min(endSec, duration))} · {chartData.length} pts
            </div>
          </div>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>

          <div style={{ padding: "12px 20px 10px", borderBottom: `1px solid ${c.border}`, flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#e2e8f0", marginBottom: 3 }}>
                  {sig?.label} · {cycle} · {activeTempKeys.join(", ")}
                </div>
                <div style={{ fontSize: 11, color: c.muted }}>
                  {fmtTime(startSec)} → {fmtTime(Math.min(endSec, duration))} window &nbsp;·&nbsp;
                  ~{sampleInterval}s sample interval &nbsp;·&nbsp;
                  {chartData.length} points per series
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {Object.entries(TEMPS).filter(([tk]) => activeTmp[tk]).map(([tk, tv]) => (
                  <div key={tk} style={{
                    background: c.card, border: `1px solid ${c.border}`,
                    borderRadius: 6, padding: "8px 14px", minWidth: 105,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 5 }}>
                      <div style={{ width: 7, height: 7, borderRadius: "50%", background: tv.color }} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: tv.color, letterSpacing: "0.04em" }}>{tk}</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, marginBottom: 2 }}>
                      {['MIN', 'AVG', 'MAX'].map(l => (
                        <span key={l} style={{ flex: 1, fontSize: 9, color: c.faint, textAlign: "center", letterSpacing: "0.05em" }}>{l}</span>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {['min', 'avg', 'max'].map(k => (
                        <span key={k} style={{ flex: 1, textAlign: "center", fontSize: 12, fontWeight: 700, color: tv.color, fontVariantNumeric: "tabular-nums" }}>
                          {stats[tk]?.[k] ?? "—"}
                          <span style={{ fontSize: 9, fontWeight: 400, color: c.faint }}>{sig?.unit}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div style={{ flex: 1, padding: "12px 12px 4px", minHeight: 0 }}>
            {parsedCodes.length === 0 && !loading && (
              <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: c.faint, gap: 10, cursor: "pointer" }}
                onClick={() => fileRef.current?.click()}>
                <div style={{ fontSize: 40 }}>📂</div>
                <div style={{ fontSize: 14, color: c.muted }}>Load a folder of temp CSVs to begin</div>
                <div style={{ fontSize: 11 }}>Example: -10C/596_UDDS.csv</div>
                <div style={{ marginTop: 8, padding: "6px 18px", border: `1px solid ${c.border2}`, borderRadius: 6, color: c.muted }}>Browse files</div>
              </div>
            )}
            {loading && (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: c.muted }}>Parsing CSV…</div>
            )}
            {parsedCodes.length > 0 && !loading && (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 24 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke="#21262d" vertical={false} />
                  <XAxis
                    dataKey="_t"
                    tickFormatter={fmtTick}
                    tick={{ fontSize: 10, fill: c.faint }}
                    tickLine={false}
                    axisLine={{ stroke: c.border }}
                    interval={Math.floor(chartData.length / 10)}
                    label={{ value: "Elapsed Time (mm:ss)", position: "insideBottom", offset: -10, fontSize: 11, fill: c.faint }}
                  />
                  <YAxis
                    domain={[yMin - yPad, yMax + yPad]}
                    tick={{ fontSize: 10, fill: c.faint }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => Number(v).toFixed(sig?.key === "SOC" ? 2 : 1)}
                    label={{ value: sig?.unit ? `${sig.label} (${sig.unit})` : sig?.label, angle: -90, position: "insideLeft", offset: 14, fontSize: 11, fill: c.faint }}
                    width={52}
                  />
                  <Tooltip content={<TTip unit={sig?.unit} dec={sig?.decimals ?? 2} />} />
                  {Object.entries(TEMPS).map(([tk, tv]) =>
                    activeTmp[tk] ? (
                      <Line key={tk} type="monotone" dataKey={tk}
                        stroke={tv.color} strokeWidth={1.5}
                        dot={false} isAnimationActive={false} connectNulls />
                    ) : null
                  )}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>

          <div style={{
            borderTop: `1px solid ${c.border}`, padding: "5px 20px",
            fontSize: 11, color: c.faint, display: "flex", justifyContent: "space-between", flexShrink: 0,
          }}>
            <span>{fileLabel}</span>
            <span>{activeTempKeys.length} temps · {parsedCodes.length} loaded code(s) · {SIGNALS.length} signals · {cycle} / {sig?.label}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
