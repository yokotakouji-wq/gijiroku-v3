import { useState, useEffect, useRef, useCallback } from "react";

const MOCK_CHUNKS = [
  "本日はお集まりいただきありがとうございます。定例の管理職会議を始めます。",
  "まず先月の売上実績の報告をお願いします。田中さん、いかがでしょうか。",
  "はい。先月の売上は前月比8%増、計画比では5%増となっております。",
  "ECサイト経由の注文が特に好調で、前年同月比では15%の伸びを記録しました。",
  "一方、実店舗の売上は前月比で若干マイナスとなっています。",
  "その原因についてはどのように分析していますか？",
  "天候不順の影響が大きかったと見ています。競合他社の新規出店も要因の一つです。",
  "なるほど。具体的な対応策は検討していますか？",
  "はい、店頭での体験型イベント強化と、SNSを活用したローカルPRを計画しています。",
  "それでは次の議題に移ります。来期の採用計画についてです。",
  "人事部の山田さんから説明をお願いします。",
  "来期は新卒採用を10名、中途採用を5名予定しています。",
  "特にエンジニア職と営業職の採用に注力したいと考えています。",
  "採用コストについてはどのくらいを見込んでいますか？",
  "一人あたりおよそ100万円を想定しております。エージェント費用込みの概算です。",
  "SNS採用やリファラル採用を強化することで30%程度削減できると試算しています。",
  "ぜひ進めてください。では採用目標の達成時期はいつを想定していますか？",
  "来期第2四半期末までに内定者を確定させる計画です。",
  "わかりました。では最後にシステム刷新プロジェクトの進捗確認をしましょう。",
  "鈴木さん、現状を教えてください。",
  "現在、要件定義フェーズを完了し、設計フェーズに入っております。",
  "予定通り来期Q2のリリースを目指していますが、一点懸念事項があります。",
  "外部ベンダーとの連携部分で若干の遅れが出る可能性があります。",
  "その場合はスコープを調整して期日を守る方向で検討しています。",
  "了解しました。週次で状況共有をお願いします。以上で本日の会議を終了します。",
];

const INTERVALS = [
  { l: "30秒", v: 30 },
  { l: "1分", v: 60 },
  { l: "2分", v: 120 },
  { l: "5分", v: 300 },
];

let _bid = 0;
const uid = () => `b${++_bid}`;

function fmt(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

const C = {
  bg: "#0d1117", surf: "#161b22", surf2: "#21262d",
  border: "#21262d", border2: "#30363d",
  text: "#e6edf3", muted: "#8b949e", faint: "#484f58",
  green: "#3fb950", red: "#f85149", blue: "#388bfd", amber: "#d29922",
};

function btn({ color = C.muted, bg = C.surf2, border = C.border2, active, inactive, small } = {}) {
  return {
    background: inactive ? C.surf2 : bg,
    border: `1px solid ${inactive ? C.border2 : border}`,
    color: inactive ? C.muted : color,
    padding: small ? "4px 10px" : "6px 14px",
    fontSize: small ? 12 : 13,
    borderRadius: 6,
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
    transition: "all .15s",
    lineHeight: 1.4,
  };
}

function BlockCard({ block: b, isActive, onUpdate, memoOpen, onToggleMemo }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(b.text);
  const [showOrig, setShowOrig] = useState(false);

  const sc = {
    unchecked: { label: "未確認", color: C.muted, bg: "rgba(139,148,158,0.12)" },
    checked:   { label: "確認済", color: C.green, bg: "rgba(63,185,80,0.12)" },
    pending:   { label: "保留",   color: C.amber, bg: "rgba(210,153,34,0.12)" },
  }[b.status];

  const leftBorder = b.important
    ? `3px solid ${C.blue}`
    : !b.include
    ? `3px solid rgba(248,81,73,0.55)`
    : `3px solid transparent`;

  const save = () => { onUpdate(b.id, { text: draft }); setEditing(false); };

  return (
    <div
      id={b.id}
      style={{
        background: C.surf,
        border: `1px solid ${isActive ? C.blue : C.border}`,
        borderLeft: leftBorder,
        borderRadius: 8,
        padding: "14px 16px",
        opacity: b.include ? 1 : 0.42,
        boxShadow: isActive ? `0 0 0 1px ${C.blue}` : "none",
        transition: "box-shadow .2s, opacity .2s",
      }}
    >
      {/* Row: meta */}
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10, flexWrap: "wrap" }}>
        <code style={{ fontSize: 11, color: C.faint, background: C.bg, padding: "2px 8px", borderRadius: 4 }}>
          {fmt(b.start)} → {fmt(b.end)}
        </code>
        <span style={{ fontSize: 11, fontWeight: 500, color: sc.color, background: sc.bg, padding: "2px 8px", borderRadius: 10 }}>
          {b.status === "checked" ? "✓ " : b.status === "pending" ? "△ " : "○ "}{sc.label}
        </span>
        {b.important && (
          <span style={{ fontSize: 11, color: C.blue, background: "rgba(56,139,253,0.12)", padding: "2px 8px", borderRadius: 10 }}>
            ★ 重要
          </span>
        )}
        {!b.include && (
          <span style={{ fontSize: 11, color: C.red, background: "rgba(248,81,73,0.1)", padding: "2px 8px", borderRadius: 10 }}>
            × 除外
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: C.faint }}>{b.sec}s枠</span>
      </div>

      {/* Text area (only if included) */}
      {b.include && (
        <>
          {editing ? (
            <div>
              <textarea
                autoFocus
                value={draft}
                onChange={e => setDraft(e.target.value)}
                rows={3}
                style={{
                  width: "100%", background: C.bg,
                  border: `1px solid ${C.blue}`, borderRadius: 6,
                  color: C.text, fontFamily: "monospace",
                  fontSize: 13, lineHeight: 1.75,
                  padding: "8px 10px", resize: "vertical",
                  outline: "none", boxSizing: "border-box",
                }}
              />
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button onClick={save} style={btn({ color: C.green, bg: "rgba(63,185,80,0.1)", border: "rgba(63,185,80,0.4)", small: true })}>保存</button>
                <button onClick={() => { setDraft(b.text); setEditing(false); }} style={btn({ small: true })}>キャンセル</button>
              </div>
            </div>
          ) : (
            <div
              onClick={() => { setEditing(true); setDraft(b.text); }}
              title="クリックして編集"
              style={{
                fontFamily: "monospace", fontSize: 13, lineHeight: 1.75,
                color: "#c9d1d9", padding: "8px 10px",
                borderRadius: 6, background: C.bg,
                border: "1px solid transparent", cursor: "text",
                minHeight: 42, transition: "border-color .15s",
              }}
              onMouseEnter={e => (e.currentTarget.style.borderColor = C.border2)}
              onMouseLeave={e => (e.currentTarget.style.borderColor = "transparent")}
            >
              {b.text || <em style={{ color: C.faint }}>(テキストなし)</em>}
            </div>
          )}

          {b.text !== b.orig && !editing && (
            <>
              <button
                onClick={() => setShowOrig(!showOrig)}
                style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: C.faint, padding: "4px 0" }}
              >
                {showOrig ? "▲ 原文を隠す" : "▾ Deepgram 原文を表示"}
              </button>
              {showOrig && (
                <div style={{ fontFamily: "monospace", fontSize: 11, color: C.muted, background: C.bg, padding: "6px 10px", borderRadius: 4, lineHeight: 1.6, marginTop: 2 }}>
                  {b.orig}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Memo */}
      {memoOpen && (
        <textarea
          value={b.memo}
          onChange={e => onUpdate(b.id, { memo: e.target.value })}
          placeholder="メモを入力（文脈補足・後で確認する事項など）"
          rows={2}
          style={{
            width: "100%", minHeight: 50, background: C.bg,
            border: `1px solid ${C.border2}`, borderRadius: 6,
            color: C.muted, fontFamily: "inherit", fontSize: 12,
            lineHeight: 1.6, padding: "6px 10px", resize: "vertical",
            outline: "none", marginTop: 10, boxSizing: "border-box",
          }}
        />
      )}

      {/* Action buttons */}
      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
        <button
          style={btn({ color: C.green, bg: "rgba(63,185,80,0.1)", border: "rgba(63,185,80,0.4)", small: true, inactive: b.status !== "checked" })}
          onClick={() => onUpdate(b.id, { status: b.status === "checked" ? "unchecked" : "checked", include: true })}
        >
          {b.status === "checked" ? "✓ 確認済" : "✓ 確認する"}
        </button>
        <button
          style={btn({ color: C.amber, bg: "rgba(210,153,34,0.1)", border: "rgba(210,153,34,0.4)", small: true, inactive: b.status !== "pending" })}
          onClick={() => onUpdate(b.id, { status: b.status === "pending" ? "unchecked" : "pending" })}
        >
          △ 保留
        </button>
        <button
          style={btn({ color: C.red, bg: "rgba(248,81,73,0.1)", border: "rgba(248,81,73,0.4)", small: true, inactive: b.include })}
          onClick={() => onUpdate(b.id, { include: !b.include, status: !b.include ? "unchecked" : "checked" })}
        >
          {b.include ? "× 除外" : "← 戻す"}
        </button>
        <button
          style={btn({ color: C.blue, bg: "rgba(56,139,253,0.1)", border: "rgba(56,139,253,0.4)", small: true, inactive: !b.important })}
          onClick={() => onUpdate(b.id, { important: !b.important })}
        >
          {b.important ? "★ 重要解除" : "★ 重要"}
        </button>
        <button
          style={btn({ color: memoOpen ? C.text : C.muted, bg: memoOpen ? C.surf2 : C.surf2, border: memoOpen ? C.border2 : C.border2, small: true })}
          onClick={onToggleMemo}
        >
          📝 メモ{memoOpen ? " ▲" : " ▾"}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [sec, setSec] = useState(60);
  const [blocks, setBlocks] = useState([]);
  const [live, setLive] = useState("");
  const [liveStart, setLiveStart] = useState(0);
  const [notice, setNotice] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [memos, setMemos] = useState({});
  const [activeId, setActiveId] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [minutes, setMinutes] = useState(null);
  const [timerKey, setTimerKey] = useState(0);

  const elR = useRef(0);
  const bufR = useRef("");
  const bufStartR = useRef(0);
  const secR = useRef(60);
  const chunkR = useRef(0);
  const atBottomR = useRef(true);
  const scrollR = useRef(null);

  secR.current = sec;
  atBottomR.current = atBottom;

  const seal = useCallback(() => {
    const t = bufR.current.trim();
    if (!t) return;
    const block = {
      id: uid(),
      start: bufStartR.current,
      end: elR.current,
      sec: secR.current,
      orig: t,
      text: t,
      status: "unchecked",
      include: true,
      important: false,
      memo: "",
    };
    bufR.current = "";
    bufStartR.current = elR.current;
    setLive("");
    setLiveStart(elR.current);
    setBlocks(p => [...p, block]);
    if (!atBottomR.current) {
      setNotice(n => n + 1);
    } else {
      setTimeout(() => scrollR.current?.scrollTo({ top: 999999, behavior: "smooth" }), 60);
    }
  }, []);

  // Elapsed + chunk timers
  useEffect(() => {
    if (!recording) return;
    const et = setInterval(() => { elR.current++; setElapsed(e => e + 1); }, 1000);
    const ct = setInterval(() => {
      if (chunkR.current < MOCK_CHUNKS.length) {
        const chunk = MOCK_CHUNKS[chunkR.current++];
        bufR.current = (bufR.current ? bufR.current + "　" : "") + chunk;
        setLive(bufR.current);
      }
    }, 3500);
    return () => { clearInterval(et); clearInterval(ct); };
  }, [recording]);

  // Block interval timer — restarts on sec change or timerKey change
  useEffect(() => {
    if (!recording) return;
    const bt = setInterval(seal, sec * 1000);
    return () => clearInterval(bt);
  }, [recording, sec, timerKey, seal]);

  const startRec = () => {
    elR.current = 0; bufR.current = ""; bufStartR.current = 0; chunkR.current = 0;
    setElapsed(0); setBlocks([]); setLive(""); setLiveStart(0);
    setNotice(0); setMinutes(null); setActiveId(null); setTimerKey(0); setMemos({});
    setRecording(true);
  };

  const stopRec = () => {
    setRecording(false);
    if (bufR.current.trim()) seal();
  };

  const cutNow = () => {
    if (!recording) return;
    seal();
    setTimerKey(k => k + 1);
  };

  const changeSec = (v) => {
    setSec(v);
    // effect handles timer restart automatically
  };

  const update = (id, u) => setBlocks(p => p.map(b => b.id === id ? { ...b, ...u } : b));

  const toLatest = () => {
    scrollR.current?.scrollTo({ top: 999999, behavior: "smooth" });
    setNotice(0); setAtBottom(true); atBottomR.current = true;
  };

  const toNextUnchecked = () => {
    const next = blocks.find(b => b.status === "unchecked" && b.include);
    if (next) {
      setActiveId(next.id);
      document.getElementById(next.id)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  const handleScroll = () => {
    if (!scrollR.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollR.current;
    const ab = scrollHeight - scrollTop - clientHeight < 80;
    setAtBottom(ab); atBottomR.current = ab;
    if (ab) setNotice(0);
  };

  const generateMinutes = async () => {
    setGenerating(true);
    const segments = blocks.map(b => ({
      start: fmt(b.start), end: fmt(b.end),
      status: b.status, include: b.include,
      ...(b.important && { important: true }),
      text: b.include ? b.text : undefined,
      ...(b.memo && { memo: b.memo }),
    }));
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: `議事録作成の専門家として以下ルールで議事録を作成してください：
・include:false のセグメントは除外
・status:pending は「※要確認」と明記
・important:true は決定事項・課題・TODOとして重視
・不明点を勝手に補完しない
・Markdown形式、日本語
・構成：日時、議題ごとの要点、決定事項、課題・TODO`,
          messages: [{
            role: "user",
            content: `以下の確認済みtranscriptで議事録を作成してください：\n${JSON.stringify({ segments }, null, 2)}`,
          }],
        }),
      });
      const data = await res.json();
      setMinutes(data.content?.map(c => c.text || "").join("") || "生成に失敗しました。");
    } catch (e) {
      setMinutes(`エラー: ${e.message}`);
    }
    setGenerating(false);
  };

  const unchecked = blocks.filter(b => b.status === "unchecked" && b.include).length;
  const checked = blocks.filter(b => b.status === "checked").length;
  const excluded = blocks.filter(b => !b.include).length;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: C.bg, color: C.text, fontFamily: "system-ui, -apple-system, 'Hiragino Sans', 'Noto Sans JP', sans-serif", fontSize: 14, overflow: "hidden" }}>
      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes slideIn { from{opacity:0;transform:translateY(-5px)} to{opacity:1;transform:translateY(0)} }
        .rdot { display:inline-block; width:7px; height:7px; border-radius:50%; background:#f85149; animation:pulse 1.5s infinite; vertical-align:middle; }
        .cblink { animation:blink 1s step-end infinite; color:${C.blue}; }
        .notif { animation:slideIn .3s ease; }
        ::-webkit-scrollbar { width:4px; }
        ::-webkit-scrollbar-thumb { background:${C.surf2}; border-radius:2px; }
        button:not(:disabled):hover { filter:brightness(1.12); cursor:pointer; }
        button:disabled { opacity:.3; cursor:not-allowed; }
      `}</style>

      {/* ── HEADER ── */}
      <div style={{ background: C.surf, borderBottom: `1px solid ${C.border}`, padding: "10px 20px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <span style={{ fontWeight: 600, fontSize: 15, letterSpacing: "-0.3px" }}>📋 議事録メーカー</span>
        <span style={{ fontSize: 11, color: C.blue, background: "rgba(56,139,253,0.12)", padding: "2px 8px", borderRadius: 10, border: "1px solid rgba(56,139,253,0.25)" }}>ライブ校正モード</span>

        {recording && (
          <>
            <div style={{ width: 1, height: 16, background: C.border }} />
            <span className="rdot" />
            <span style={{ fontSize: 12, color: C.red, fontWeight: 500 }}>REC</span>
            <code style={{ fontSize: 13, color: C.text, background: C.bg, padding: "2px 8px", borderRadius: 4 }}>{fmt(elapsed)}</code>
            <span style={{ fontSize: 11, color: C.faint }}>Deepgram 接続中</span>
          </>
        )}

        {blocks.length > 0 && (
          <>
            <div style={{ width: 1, height: 16, background: C.border, marginLeft: 4 }} />
            <span style={{ fontSize: 12, color: C.muted }}>
              <span style={{ color: C.green }}>✓{checked}</span>
              {" / 未"}{unchecked}
              {" / "}
              <span style={{ textDecoration: "line-through", color: C.faint }}>除{excluded}</span>
            </span>
          </>
        )}

        <div style={{ flex: 1 }} />

        {!recording ? (
          <button
            onClick={startRec}
            style={{ ...btn({ color: C.green, bg: "rgba(63,185,80,0.1)", border: "rgba(63,185,80,0.4)" }), padding: "7px 20px", fontWeight: 500 }}
          >
            ● 録音開始
          </button>
        ) : (
          <button
            onClick={stopRec}
            style={{ ...btn({ color: C.red, bg: "rgba(248,81,73,0.1)", border: "rgba(248,81,73,0.4)" }), padding: "7px 20px", fontWeight: 500 }}
          >
            ■ 録音停止
          </button>
        )}
      </div>

      {/* ── CONTROLS ── */}
      <div style={{ background: C.bg, borderBottom: `1px solid ${C.border}`, padding: "8px 20px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flexShrink: 0 }}>
        <span style={{ fontSize: 12, color: C.muted, whiteSpace: "nowrap" }}>確認間隔：</span>
        <div style={{ display: "flex", gap: 4 }}>
          {INTERVALS.map(o => (
            <button
              key={o.v}
              onClick={() => changeSec(o.v)}
              style={btn({ color: C.blue, bg: "rgba(56,139,253,0.12)", border: "rgba(56,139,253,0.4)", small: true, inactive: sec !== o.v })}
            >
              {o.l}
            </button>
          ))}
        </div>

        <button
          onClick={cutNow}
          disabled={!recording}
          style={{ ...btn({ color: C.blue, border: "rgba(56,139,253,0.45)", small: true }), borderStyle: "dashed", background: "rgba(56,139,253,0.06)" }}
        >
          ✂ 今すぐ区切る
        </button>

        <div style={{ flex: 1 }} />

        <button onClick={toNextUnchecked} disabled={unchecked === 0} style={btn({ small: true })}>
          → 次の未確認
          {unchecked > 0 && (
            <span style={{ marginLeft: 5, background: "#1f6feb", color: "#fff", borderRadius: 8, padding: "1px 5px", fontSize: 10 }}>{unchecked}</span>
          )}
        </button>
        <button onClick={toLatest} style={btn({ small: true })}>↓ 最新へ戻る</button>
      </div>

      {/* ── NOTIFICATION ── */}
      {notice > 0 && (
        <div className="notif" style={{ background: "rgba(31,111,235,0.08)", borderBottom: "1px solid rgba(31,111,235,0.2)", padding: "7px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: C.blue, flexShrink: 0 }}>
          <span>+ 新しいブロックが {notice} 件追加されました</span>
          <button onClick={toLatest} style={{ background: "none", border: "none", color: C.blue, cursor: "pointer", fontSize: 12, textDecoration: "underline" }}>最新を見る →</button>
        </div>
      )}

      {/* ── SCROLL AREA ── */}
      <div
        ref={scrollR}
        onScroll={handleScroll}
        style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}
      >
        <div style={{ maxWidth: 840, margin: "0 auto", display: "flex", flexDirection: "column", gap: 10 }}>

          {/* Empty state */}
          {!recording && blocks.length === 0 && (
            <div style={{ textAlign: "center", padding: "80px 20px", color: C.muted }}>
              <div style={{ fontSize: 40, marginBottom: 16 }}>🎙</div>
              <div style={{ fontSize: 16, color: C.text, marginBottom: 10, fontWeight: 500 }}>録音を開始してください</div>
              <div style={{ fontSize: 13, lineHeight: 1.8, color: C.muted }}>
                確認間隔ごとに文字起こしブロックが自動生成されます<br />
                会議中に各ブロックを確認・修正・仕分けし、<br />
                終了時点で確認済み transcript を完成させます
              </div>
              <div style={{ marginTop: 24, display: "flex", justifyContent: "center", gap: 24, fontSize: 12, color: C.faint }}>
                <span>✓ 確認済 → 信頼度高</span>
                <span>△ 保留 → 要確認</span>
                <span>× 除外 → 議事録に含めない</span>
                <span>★ 重要 → 決定事項候補</span>
              </div>
            </div>
          )}

          {/* Blocks */}
          {blocks.map(b => (
            <BlockCard
              key={b.id}
              block={b}
              isActive={activeId === b.id}
              onUpdate={update}
              memoOpen={!!memos[b.id]}
              onToggleMemo={() => setMemos(m => ({ ...m, [b.id]: !m[b.id] }))}
            />
          ))}

          {/* Live buffer */}
          {recording && live && (
            <div style={{ background: "rgba(56,139,253,0.04)", border: "1px dashed rgba(56,139,253,0.3)", borderRadius: 8, padding: "14px 16px" }}>
              <div style={{ fontSize: 11, color: C.blue, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                <span className="rdot" style={{ background: C.blue, width: 6, height: 6 }} />
                <code style={{ color: C.faint }}>{fmt(liveStart)}</code>
                <span style={{ color: C.faint }}>書き起こし中 • 次のブロックまで最大 {sec}秒</span>
              </div>
              <div style={{ fontFamily: "monospace", fontSize: 13, lineHeight: 1.8, color: C.muted }}>
                {live}<span className="cblink">▋</span>
              </div>
            </div>
          )}

          {recording && !live && blocks.length === 0 && (
            <div style={{ textAlign: "center", padding: 40, color: C.faint, fontSize: 13 }}>
              <span className="rdot" style={{ marginRight: 8 }} />音声を認識中...
            </div>
          )}

          {/* Generate section */}
          {!recording && blocks.length > 0 && (
            <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 20, marginTop: 8, textAlign: "center" }}>
              {unchecked > 0 && (
                <div style={{ display: "inline-block", fontSize: 12, color: C.amber, background: "rgba(210,153,34,0.08)", border: "1px solid rgba(210,153,34,0.25)", borderRadius: 6, padding: "7px 16px", marginBottom: 14 }}>
                  ⚠ 未確認のブロックが {unchecked} 件あります。確認後に生成すると精度が上がります
                </div>
              )}
              <div>
                <button
                  onClick={generateMinutes}
                  disabled={generating}
                  style={{ ...btn({ color: C.green, bg: "rgba(63,185,80,0.1)", border: "rgba(63,185,80,0.4)" }), padding: "10px 30px", fontSize: 14, fontWeight: 500 }}
                >
                  {generating ? "⏳ 議事録を生成中..." : "📄 議事録を生成する（Claude）"}
                </button>
              </div>
            </div>
          )}

          {/* Minutes output */}
          {minutes && (
            <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 20, marginTop: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <span style={{ fontWeight: 500, fontSize: 14 }}>📄 生成された議事録</span>
                <button
                  onClick={() => navigator.clipboard?.writeText(minutes)}
                  style={btn({ small: true })}
                >
                  📋 コピー
                </button>
              </div>
              <pre style={{ fontFamily: "monospace", fontSize: 12.5, lineHeight: 1.85, color: "#c9d1d9", whiteSpace: "pre-wrap", wordBreak: "break-word", margin: 0 }}>
                {minutes}
              </pre>
            </div>
          )}

          <div style={{ height: 60 }} />
        </div>
      </div>
    </div>
  );
}
