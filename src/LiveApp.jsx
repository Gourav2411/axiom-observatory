import { useEffect, useRef, useState } from "react";
import {
  ArrowClockwise, ArrowLeft, ArrowSquareOut, CheckCircle, CloudCheck, Database,
  DownloadSimple, EnvelopeSimple, Flask, GoogleLogo, Key, LockKey, MagnifyingGlass,
  Play, ShieldWarning, SignOut, Sparkle, UserCircle, Warning, X,
} from "@phosphor-icons/react";
import { api } from "./api.js";
import {
  authErrorMessage, authIntentFromRedirectType, authSuccessMessage,
  clearAuthCallbackLocation, exchangeAuthCallback, googleSignIn, passwordSignIn,
  isDuplicateSignupError, isMissingMagicAccountError, passwordSignUp,
  readAuthCallback, sendMagicLink,
  sendPasswordReset, updatePassword, validateNewPassword,
} from "./auth-flow.js";
import { supabase, supabaseBrowserConfigured, supabaseGoogleConfigured } from "./supabase.js";

const SAVED_RUN_KEY = "axiom:last-evidence-run";
const RUN_TABS = ["Research", "Index", "Evidence", "Literature", "Provenance", "Capabilities"];
const INDEX_COUNTS = [
  ["sources", "Sources"],
  ["evidenceRecords", "Evidence records"],
  ["literatureRecords", "Literature records"],
  ["documents", "Documents"],
  ["chunks", "Chunks"],
  ["embeddedChunks", "Embedded chunks"],
];
const INITIAL_AUTH_CALLBACK = readAuthCallback();

function savedRunId() {
  try {
    const value = JSON.parse(localStorage.getItem(SAVED_RUN_KEY) || "null");
    return typeof value === "string" ? value : value?.id ?? null;
  } catch {
    return null;
  }
}

function persistenceState(value) {
  if (typeof value === "string") return { mode: value, durable: value === "supabase_postgres" };
  return {
    mode: value?.mode ?? "ephemeral_memory",
    durable: Boolean(value?.durable),
    configured: Boolean(value?.configured),
  };
}

function humanize(value) {
  return String(value ?? "").replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
}

function present(value) {
  return value !== undefined && value !== null && value !== "";
}

function displayValue(value) {
  return present(value) ? String(value) : "Unavailable";
}

function decimal(value, places = 3) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(places) : "Unavailable";
}

function retrievalMode(value) {
  const raw = present(value) ? String(value) : "";
  const normalized = raw.toLowerCase();
  if (normalized.includes("hybrid")) return { kind: "hybrid", label: "Hybrid retrieval", raw };
  if (normalized.includes("lexical")) return { kind: "lexical", label: "Lexical retrieval", raw };
  return { kind: raw ? "reported" : "unavailable", label: raw ? humanize(raw) : "Mode unavailable", raw };
}

function statusTone(status) {
  const value = String(status ?? "").toLowerCase();
  if (["completed", "complete", "available", "connected", "configured", "enabled", "ok", "passed", "ready", "success"].includes(value)) return "available";
  if (["degraded", "fallback", "partial", "warning"].includes(value)) return "degraded";
  if (["running", "active", "in_progress", "processing"].includes(value)) return "active";
  return "unavailable";
}

function StageCard({ stage, selected, onClick }) {
  const status = stage.status ?? "unknown";
  const itemSummary = present(stage.itemCount) ? `${stage.itemCount} retrieved records` : "Item count unavailable";
  return <button type="button" className={`live-stage live-${status} ${selected ? "is-selected" : ""}`} onClick={onClick} aria-pressed={selected}>
    <div className="live-stage-head"><span>{stage.id === "evidence" || stage.id === "rag_index" ? <Database/> : stage.id === "literature" ? <MagnifyingGlass/> : <Flask/>}</span><strong>{stage.label || humanize(stage.id) || "Unnamed stage"}</strong><i>{humanize(status)}</i></div>
    <h3>{stage.service || "Service unavailable"}</h3>
    <p>{stage.reason ?? itemSummary}</p>
    <span className="live-stage-foot">{stage.evidenceKind ? humanize(stage.evidenceKind) : "Stage metadata unavailable"}</span>
  </button>;
}

function SearchField({ label, placeholder, value, onChange, onSearch, searching, items, selected, onSelect }) {
  return <div className="live-search-field">
    <label>{label}</label>
    <div className="live-search-box"><MagnifyingGlass/><input value={value} onChange={(event)=>onChange(event.target.value)} onKeyDown={(event)=>event.key === "Enter" && onSearch()} placeholder={placeholder}/><button onClick={onSearch} disabled={searching || value.trim().length < 2}>{searching ? "Searching…" : "Search"}</button></div>
    {items.length > 0 && <div className="live-results">{items.map(item=><button className={selected?.id===item.id?"is-selected":""} key={item.id} onClick={()=>onSelect(item)}><span><strong>{item.label}</strong><small>{item.description || item.entityType}</small></span><code>{item.id}</code></button>)}</div>}
    {selected && <div className="live-selection"><CheckCircle weight="fill"/><span><strong>{selected.label}</strong><small>{selected.id}</small></span></div>}
  </div>;
}

const AUTH_MODE_COPY = {
  "sign-in": {
    title: "Enter the observatory.",
    description: "Resume a protected evidence workspace with your email and password.",
    submit: "Sign in",
    busy: "Signing in…",
  },
  "sign-up": {
    title: "Create your workspace.",
    description: "Use a verified email to create a durable, access-controlled research workspace.",
    submit: "Create account",
    busy: "Creating account…",
  },
  magic: {
    title: "Sign in without a password.",
    description: "We will send a single-use link. Open it in this same browser to enter an existing workspace.",
    submit: "Send magic link",
    busy: "Sending link…",
  },
  reset: {
    title: "Reset your password.",
    description: "We will email a secure recovery link. Open it in this same browser to continue.",
    submit: "Send reset link",
    busy: "Sending reset link…",
  },
};

function AuthFeedback({ error, message, id = "auth-feedback" }) {
  if (error) return <div className="live-error" id={id} role="alert"><Warning/>{error}</div>;
  if (message) return <div className="live-auth-message" id={id} role="status"><CheckCircle/>{message}</div>;
  return null;
}

function AuthPanel({ initialMode = "sign-in", initialError = "", onLeaveCallback }) {
  const [mode,setMode]=useState(initialMode); const [email,setEmail]=useState(""); const [password,setPassword]=useState("");
  const [loading,setLoading]=useState(false); const [error,setError]=useState(initialError); const [message,setMessage]=useState("");
  const headingRef=useRef(null); const previousMode=useRef(mode);
  const copy=AUTH_MODE_COPY[mode]; const emailOnly=mode==="magic"||mode==="reset"; const showProviders=mode==="sign-in"||mode==="sign-up";
  useEffect(()=>{if(previousMode.current!==mode)headingRef.current?.focus();previousMode.current=mode;},[mode]);
  const changeMode=(next)=>{if(loading)return;setMode(next);setError("");setMessage("");if(next==="sign-in")onLeaveCallback?.();};
  const submit=async(event)=>{
    event.preventDefault(); setLoading(true); setError(""); setMessage("");
    try {
      if(mode==="sign-in")await passwordSignIn(supabase,{email,password});
      if(mode==="sign-up"){
        const data=await passwordSignUp(supabase,{email,password});
        if(!data.session)setMessage("Check your inbox to confirm the account, then return here to sign in.");
      }
      if(mode==="magic"){
        await sendMagicLink(supabase,{email});
        setMessage("If this address can sign in, a magic link is on its way. Open it in this same browser.");
      }
      if(mode==="reset"){
        await sendPasswordReset(supabase,{email});
        setMessage("If an account exists, a reset link is on its way. Open it in this same browser.");
      }
    } catch(authError) {
      const absentMagicAccount=mode==="magic"&&isMissingMagicAccountError(authError);
      const duplicateSignup=mode==="sign-up"&&isDuplicateSignupError(authError);
      if(absentMagicAccount)setMessage("If this address can sign in, a magic link is on its way. Open it in this same browser.");
      else if(duplicateSignup)setMessage("Check your inbox to confirm the account, then return here to sign in.");
      else setError(authErrorMessage(authError));
    } finally {
      setLoading(false);
    }
  };
  const signInWithGoogle=async()=>{
    if(!supabaseGoogleConfigured)return;
    setLoading(true);setError("");setMessage("");
    try { await googleSignIn(supabase,{}); }
    catch(authError){setError(authErrorMessage(authError));}
    finally { setLoading(false); }
  };
  return <main className="live-shell live-auth"><section className="live-auth-card">
    {emailOnly&&<button type="button" className="live-auth-back" onClick={()=>changeMode("sign-in")} disabled={loading}><ArrowLeft/> Back to sign in</button>}
    <span className="live-kicker"><LockKey/> Protected workspace</span><h1 ref={headingRef} tabIndex="-1">{copy.title}</h1><p>{copy.description}</p>
    {showProviders&&<>
      <button type="button" className="live-oauth-button" onClick={signInWithGoogle} disabled={loading||!supabaseGoogleConfigured}><GoogleLogo weight="bold"/><span>{supabaseGoogleConfigured?"Continue with Google":"Google sign-in unavailable"}</span></button>
      {!supabaseGoogleConfigured&&<p className="live-auth-provider-note">Continue with email while Google access is unavailable.</p>}
      <div className="live-auth-divider"><span>or continue with email</span></div>
    </>}
    <form onSubmit={submit}>
      <label htmlFor="auth-email">Email<input id="auth-email" type="email" value={email} onChange={(event)=>setEmail(event.target.value)} autoComplete="email" inputMode="email" aria-describedby={error||message?"auth-feedback":undefined} aria-invalid={Boolean(error)} disabled={loading} required/></label>
      {!emailOnly&&<label htmlFor="auth-password">Password<input id="auth-password" type="password" value={password} onChange={(event)=>setPassword(event.target.value)} autoComplete={mode==="sign-in"?"current-password":"new-password"} minLength={mode==="sign-up"?10:undefined} aria-describedby={mode==="sign-up"?"auth-password-help":error?"auth-feedback":undefined} aria-invalid={Boolean(error)} disabled={loading} required/>{mode==="sign-up"&&<small id="auth-password-help" className="live-auth-field-help">Use at least 10 characters.</small>}</label>}
      <AuthFeedback error={error} message={message}/>
      <button type="submit" className="live-primary" disabled={loading}>{loading?copy.busy:copy.submit}</button>
    </form>
    {mode==="sign-in"&&<div className="live-auth-actions"><button type="button" onClick={()=>changeMode("magic")} disabled={loading}><EnvelopeSimple/> Use a magic link</button><button type="button" onClick={()=>changeMode("reset")} disabled={loading}><Key/> Forgot password?</button></div>}
    {showProviders&&<button type="button" className="live-auth-switch" onClick={()=>changeMode(mode==="sign-up"?"sign-in":"sign-up")} disabled={loading}>{mode==="sign-up"?"Already registered? Sign in":"New to Axiom? Create an account"}</button>}
    <p className="live-auth-security">Your session token is forwarded only to the evidence API. Service-role credentials remain server-side.</p>
  </section></main>;
}

function PasswordRecoveryPanel({ onComplete, onCancel }) {
  const [password,setPassword]=useState(""); const [confirmation,setConfirmation]=useState("");
  const [loading,setLoading]=useState(false); const [error,setError]=useState("");
  const submit=async(event)=>{
    event.preventDefault();setError("");
    const validationError=validateNewPassword(password,confirmation);
    if(validationError){setError(validationError);return;}
    setLoading(true);
    try { await updatePassword(supabase,password);onComplete(); }
    catch(authError){setError(authErrorMessage(authError));setLoading(false);}
  };
  return <main className="live-shell live-auth"><section className="live-auth-card">
    <span className="live-kicker"><Key/> Account recovery</span><h1>Choose a new password.</h1><p>Your recovery link created a temporary authenticated session. Update the password before entering the workspace.</p>
    <form onSubmit={submit}>
      <label htmlFor="new-password">New password<input id="new-password" type="password" value={password} onChange={(event)=>setPassword(event.target.value)} autoComplete="new-password" minLength="10" aria-describedby={error?"recovery-feedback":"recovery-password-help"} aria-invalid={Boolean(error)} disabled={loading} required/><small id="recovery-password-help" className="live-auth-field-help">Use at least 10 characters.</small></label>
      <label htmlFor="confirm-password">Confirm password<input id="confirm-password" type="password" value={confirmation} onChange={(event)=>setConfirmation(event.target.value)} autoComplete="new-password" minLength="10" aria-describedby={error?"recovery-feedback":undefined} aria-invalid={Boolean(error)} disabled={loading} required/></label>
      <AuthFeedback error={error} id="recovery-feedback"/><button type="submit" className="live-primary" disabled={loading}>{loading?"Updating password…":"Update password"}</button>
    </form>
    <button type="button" className="live-auth-switch" onClick={onCancel} disabled={loading}>Cancel and sign out</button>
  </section></main>;
}

function AuthNotice({ message, onDismiss, tone = "success" }) {
  if(!message)return null;
  return <div className={`live-auth-notice is-${tone}`} role={tone==="error"?"alert":"status"}>{tone==="error"?<Warning weight="fill"/>:<CheckCircle weight="fill"/>}<span>{message}</span><button type="button" aria-label="Dismiss" onClick={onDismiss}><X/></button></div>;
}

function AuthConfigurationMissing() {
  return <main className="live-shell live-auth"><section><span className="live-kicker"><ShieldWarning/> Configuration required</span><h1>Browser Auth is not configured.</h1><p>The API is using Supabase, but the frontend is missing <code>VITE_SUPABASE_URL</code> or <code>VITE_SUPABASE_PUBLISHABLE_KEY</code>. Add both values and restart the development server.</p></section></main>;
}

function Setup({ health, onRun, user, onSignOut }) {
  const [targetQuery,setTargetQuery]=useState("TNIK");
  const [diseaseQuery,setDiseaseQuery]=useState("idiopathic pulmonary fibrosis");
  const [targets,setTargets]=useState([]); const [diseases,setDiseases]=useState([]);
  const [target,setTarget]=useState(null); const [disease,setDisease]=useState(null);
  const [loading,setLoading]=useState(""); const [error,setError]=useState("");
  const persistence=persistenceState(health?.persistence);
  const search = async(type) => {
    const isTarget=type==="target"; setLoading(type); setError("");
    try { const data=await (isTarget?api.searchTargets(targetQuery):api.searchDiseases(diseaseQuery)); isTarget?setTargets(data.items??[]):setDiseases(data.items??[]); }
    catch(e){setError(e.message);} finally{setLoading("");}
  };
  return <section className="live-setup">
    <div className="live-setup-copy"><span className="live-kicker"><Sparkle weight="fill"/> Evidence run</span><h1>Start with identifiers,<br/>not assumptions.</h1><p>Resolve a therapeutic target and disease against Open Targets, then retrieve direct evidence and literature with source-level provenance.</p><div className="live-health"><i className={health?.status==="ok"?"ok":""}/><span>{health?.status==="ok"?"Evidence API connected":health?.status==="degraded"?"Evidence API needs configuration":"Checking evidence API…"}</span><small>{!health?"Confirming persistence configuration…":health.status==="degraded"?"Supabase configuration is incomplete; durable reads and writes are unavailable.":persistence.durable?"Supabase Postgres is configured for durable evidence runs.":"Local memory fallback is active; configure Supabase to make runs durable."}</small></div></div>
    <div className="live-setup-form">
      {user&&<div className="live-session"><UserCircle/><span><small>Authenticated workspace</small><strong>{user.email}</strong></span><button onClick={onSignOut}><SignOut/> Sign out</button></div>}
      <SearchField label="01 · Therapeutic target" placeholder="Gene symbol or target name" value={targetQuery} onChange={(value)=>{setTargetQuery(value);setTarget(null);setTargets([]);}} onSearch={()=>search("target")} searching={loading==="target"} items={targets} selected={target} onSelect={setTarget}/>
      <SearchField label="02 · Disease or phenotype" placeholder="Disease name" value={diseaseQuery} onChange={(value)=>{setDiseaseQuery(value);setDisease(null);setDiseases([]);}} onSearch={()=>search("disease")} searching={loading==="disease"} items={diseases} selected={disease} onSelect={setDisease}/>
      {error && <div className="live-error"><Warning/>{error}</div>}
      <button className="live-primary" disabled={!target||!disease||loading==="run"} onClick={async()=>{setLoading("run");setError("");try{await onRun({targetId:target.id,targetLabel:target.label,diseaseId:disease.id,diseaseLabel:disease.label});}catch(e){setError(e.message);}finally{setLoading("");}}}><Play weight="fill"/>{loading==="run"?"Retrieving live evidence…":"Create evidence run"}</button>
      <p className="live-honesty">No model output is simulated. Unconfigured computational stages remain visibly unavailable.</p>
    </div>
  </section>;
}

function EvidenceTable({ run }) {
  const items=run.evidence?.items??[];
  if(!items.length) return <Empty title="No direct evidence records returned" detail="The association may be absent, outside this page, or the upstream pair-evidence query may have failed."/>;
  return <div className="live-data-table"><div className="live-table-head"><span>Data type</span><span>Data source</span><span>Upstream score</span><span>Reference</span></div>{items.slice(0,30).map(item=><div className="live-table-row" key={item.id}><strong>{item.datatypeId||"unclassified"}</strong><span>{item.datasourceId||"unknown"}</span><code>{item.upstreamScore == null ? "—" : Number(item.upstreamScore).toFixed(3)}</code><span>{item.studyId||item.variantId||item.drugId||item.literatureIds?.[0]||"—"}</span></div>)}</div>;
}

function Literature({ run }) {
  const items=run.literature?.items??[];
  if(!items.length) return <Empty title="No literature records returned" detail={`Query: ${run.literature?.query??"not available"}`}/>;
  return <div className="live-literature">{items.map(item=><article key={item.id}><div><span>{item.publicationDate||"Date unavailable"}</span><span>{item.citedByCount} citations</span>{item.isOpenAccess&&<span className="oa">Open access</span>}</div><h3>{item.title}</h3><p>{item.authors||"Authors unavailable"} · {item.journal||"Journal unavailable"}</p>{item.sourceUrl&&<a href={item.sourceUrl} target="_blank" rel="noreferrer">Open source record <ArrowSquareOut/></a>}</article>)}</div>;
}

function RetrievalWorkflow({ retrieval, mode, waiting }) {
  const reported = Array.isArray(retrieval?.workflow) && retrieval.workflow.length > 0;
  const waitingStatus = waiting ? "awaiting_response" : retrieval ? "status_unavailable" : "not_run";
  const steps = reported ? retrieval.workflow : [
    { step: "planner", label: "Planner", status: waitingStatus },
    { step: "retriever", label: mode.kind === "lexical" ? "Lexical retriever" : "Hybrid retriever", status: waitingStatus },
    { step: "citation_guard", label: "Citation guard", status: waitingStatus },
  ];
  return <section className="live-agent-workflow" aria-label="Retrieval agent workflow">
    <header><span>Agent workflow</span><small>{reported ? "Server-reported execution" : waiting ? "Awaiting server report" : retrieval ? "Execution details unavailable" : "Not run"}</small></header>
    <div>{steps.map((step, index) => {
      const status = step?.status ?? "unavailable";
      return <div className={`live-agent-step is-${statusTone(status)}`} key={step?.step ?? `${step?.label}-${index}`}>
        <i aria-hidden="true">{String(index + 1).padStart(2, "0")}</i>
        <span><strong>{step?.label || humanize(step?.step) || "Unnamed step"}</strong><small>{humanize(status)}</small></span>
      </div>;
    })}</div>
  </section>;
}

function coverageValue(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return displayValue(value);
  const percentage = value <= 1 ? value * 100 : value;
  return `${percentage.toFixed(Number.isInteger(percentage) ? 0 : 1)}%`;
}

function CitationAudit({ audit }) {
  if (!audit || typeof audit !== "object") return <section className="live-citation-audit is-unavailable" aria-label="Citation audit unavailable">
    <ShieldWarning/><span><strong>Citation audit unavailable</strong><small>No citation audit was returned for this retrieval.</small></span><b>—</b>
  </section>;
  const status = audit.status ?? "unavailable";
  const totalsAvailable = present(audit.citedResults) && present(audit.totalResults);
  return <section className={`live-citation-audit is-${statusTone(status)}`} aria-label="Citation audit">
    {statusTone(status) === "available" ? <CheckCircle/> : <ShieldWarning/>}
    <span><strong>Citation guard · {humanize(status)}</strong><small>{totalsAvailable ? `${audit.citedResults} of ${audit.totalResults} results cited` : "Cited-result totals unavailable"}</small></span>
    <b>{present(audit.coverage) ? coverageValue(audit.coverage) : "Unavailable"}</b>
  </section>;
}

function ResultScores({ result }) {
  const scores = result.scores && typeof result.scores === "object" ? result.scores : {};
  const ranks = result.ranks && typeof result.ranks === "object" ? result.ranks : {};
  const scoreItems = [
    [present(scores.fused) ? "Fused ranking" : "Ranking score", present(scores.fused) ? scores.fused : result.score],
    ["Lexical ranking", scores.lexical],
    ["Vector similarity", scores.vector],
  ].filter(([, value]) => present(value));
  const rankItems = [
    ["Lexical rank", ranks.lexical],
    ["Semantic rank", ranks.semantic],
  ].filter(([, value]) => present(value));
  if (!scoreItems.length && !rankItems.length) return <small className="live-score-unavailable">Ranking details unavailable</small>;
  return <dl className="live-result-scores">
    {scoreItems.map(([label, value])=><div key={label}><dt>{label}</dt><dd>{decimal(value)}</dd></div>)}
    {rankItems.map(([label, value])=><div key={label}><dt>{label}</dt><dd>#{value}</dd></div>)}
  </dl>;
}

function Research({ run, accessToken }) {
  const [question, setQuestion] = useState(`What evidence links ${run.target?.label ?? "this target"} to ${run.disease?.label ?? "this disease"}?`);
  const [retrieval, setRetrieval] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const indexMode = retrievalMode(run.rag?.mode);
  const responseMode = retrievalMode(retrieval?.retrievalMode ?? retrieval?.mode ?? run.rag?.mode);
  const results = Array.isArray(retrieval?.results) ? retrieval.results : [];

  const submit = async (event) => {
    event.preventDefault();
    const query = question.trim();
    if (query.length < 3 || loading) return;
    setLoading(true);
    setError("");
    try {
      const request = { query, topK: 8 };
      if (["hybrid", "lexical"].includes(indexMode.kind)) request.mode = indexMode.kind;
      setRetrieval(await api.retrieveRun(run.id, request, accessToken));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  };

  return <div className="live-research">
    <section className="live-research-intro">
      <div><span className="live-kicker"><MagnifyingGlass/> Grounded retrieval</span><h2>Search within this evidence run</h2><p>Rank passages from the retrieved evidence and literature. Results remain linked to their source records.</p></div>
      <div className="live-no-generation" role="note"><ShieldWarning/><span><strong>No generated scientific answer</strong><small>This stage retrieves passages only. It does not synthesize claims, infer causality, or provide clinical advice.</small></span></div>
    </section>
    <form className="live-research-form" onSubmit={submit} aria-busy={loading}>
      <label htmlFor="live-research-question">Research question</label>
      <div><MagnifyingGlass/><input id="live-research-question" value={question} onChange={(event)=>setQuestion(event.target.value)} placeholder="Ask about mechanisms, evidence, or literature" aria-describedby="live-research-help"/><button type="submit" disabled={loading || question.trim().length < 3}>{loading ? "Retrieving…" : "Retrieve passages"}</button></div>
      <small id="live-research-help">{indexMode.kind === "hybrid" ? "Hybrid retrieval is requested from this run's indexed evidence; the response reports the actual mode used." : indexMode.kind === "lexical" ? "Lexical ranking is available for this run; no vector similarity is implied." : "The API response will report the ranking mode used for this run."}</small>
    </form>
    <RetrievalWorkflow retrieval={retrieval} mode={responseMode} waiting={loading}/>
    {error && <div className="live-error" role="alert"><Warning/><span><strong>Retrieval failed</strong><small>{error}</small></span></div>}
    {loading && <div className="live-retrieval-loading" role="status" aria-live="polite"><span/><p>Ranking grounded passages…</p></div>}
    {!loading && retrieval && <section className="live-retrieval-results" aria-live="polite">
      <header><div><span>{results.length} ranked passages</span><small>{present(retrieval.totalCandidates) ? `${retrieval.totalCandidates} candidates` : "Candidate count unavailable"}{responseMode.raw ? ` · ${humanize(responseMode.raw)}` : ""}</small>{retrieval.embedding && <em>{[retrieval.embedding.model, retrieval.embedding.revision, present(retrieval.embedding.dimensions) ? `${retrieval.embedding.dimensions} dimensions` : null].filter(present).join(" · ") || "Embedding metadata unavailable"}</em>}</div><div className="live-retrieval-badges"><strong className={`live-mode-badge is-${responseMode.kind}`}>{responseMode.label}</strong><strong className={`live-generation-badge ${retrieval.generated === false ? "is-safe" : retrieval.generated === true ? "is-generated" : "is-unavailable"}`}>{retrieval.generated === false ? "Retrieval only" : retrieval.generated === true ? "Generation reported" : "Generation status unavailable"}</strong></div></header>
      <CitationAudit audit={retrieval.citationAudit}/>
      {retrieval.warnings?.map((warning,index)=><p className="live-retrieval-warning" key={`${warning}-${index}`}><Warning/>{warning}</p>)}
      {results.length === 0 ? <Empty title="No matching passages" detail="Try a more specific target, mechanism, study, or disease phrase."/> : <div className="live-retrieval-list">{results.map((result, index)=><article key={result.id ?? index}>
        <div className="live-retrieval-rank"><span>Result rank</span><strong>{String(index + 1).padStart(2, "0")}</strong></div>
        <div className="live-retrieval-copy"><div><span>{result.sourceType ? humanize(result.sourceType) : "Source type unavailable"}</span>{result.citations?.slice(0, 3).map((citation,index)=>{const label=typeof citation === "string" ? citation : citation?.id ?? citation?.label; return present(label) ? <code key={`${label}-${index}`}>{label}</code> : null;})}</div><h3>{result.title || "Untitled source record"}</h3><p>{result.excerpt || "No excerpt returned."}</p><ResultScores result={result}/>{result.sourceUrl && <a href={result.sourceUrl} target="_blank" rel="noreferrer">Open source record <ArrowSquareOut/></a>}</div>
      </article>)}</div>}
    </section>}
    {!loading && !retrieval && <div className="live-research-empty"><Database/><p>Enter a question to retrieve the most relevant grounded passages from this run.</p></div>}
  </div>;
}

function RagIndex({ run }) {
  const rag = run.rag;
  if (!rag || typeof rag !== "object") return <Empty title="RAG index unavailable" detail="This run did not return normalized index metadata. Retrieval may still report a lexical fallback, but no hybrid index is implied."/>;
  const stage = run.stages?.find((item)=>item.id === "rag_index");
  const status = rag.status ?? stage?.status ?? "unavailable";
  const mode = retrievalMode(rag.mode);
  const normalized = rag.normalized === true ? "Complete" : rag.normalized === false ? "Not complete" : displayValue(rag.normalized);
  return <div className="live-index">
    <header className="live-index-header">
      <div><span className="live-kicker"><Database/> Retrieval index</span><h2>Normalized evidence index</h2><p>Inspectable ingestion, chunking, and embedding metadata for this run. These fields describe retrieval infrastructure, not scientific validation.</p></div>
      <div className="live-index-state"><strong className={`is-${statusTone(status)}`}>{humanize(status)}</strong><span className={`live-mode-badge is-${mode.kind}`}>{mode.label}</span></div>
    </header>
    <section className="live-index-counts" aria-label="Indexed record counts">
      {INDEX_COUNTS.map(([key,label])=><div key={key}><span>{label}</span><strong>{present(rag.counts?.[key]) ? rag.counts[key] : "—"}</strong><small>{present(rag.counts?.[key]) ? "Reported by index" : "Unavailable"}</small></div>)}
    </section>
    <div className="live-index-grid">
      <section><header><span>Embedding provenance</span><small>Model identity</small></header><dl>
        <div><dt>Model</dt><dd>{displayValue(rag.model)}</dd></div>
        <div><dt>Revision</dt><dd><code>{displayValue(rag.revision)}</code></dd></div>
        <div><dt>Dimensions</dt><dd>{displayValue(rag.dimensions)}</dd></div>
        <div><dt>Index mode</dt><dd>{displayValue(rag.mode)}</dd></div>
        <div><dt>Normalized</dt><dd>{normalized}</dd></div>
      </dl></section>
      <section><header><span>Chunking policy</span><small>Reported configuration</small></header><dl>
        <div><dt>Strategy</dt><dd>{displayValue(rag.chunking?.strategy)}</dd></div>
        <div><dt>Maximum words</dt><dd>{displayValue(rag.chunking?.maxWords)}</dd></div>
        <div><dt>Overlap words</dt><dd>{displayValue(rag.chunking?.overlapWords)}</dd></div>
      </dl></section>
    </div>
    <section className={`live-index-fallback ${present(rag.fallbackReason) ? "has-reason" : ""}`}>
      {present(rag.fallbackReason) ? <Warning/> : <ShieldWarning/>}<span><strong>{present(rag.fallbackReason) ? "Retrieval fallback reported" : "Fallback reason unavailable"}</strong><small>{present(rag.fallbackReason) ? rag.fallbackReason : "The run did not report a fallback reason. Check each retrieval response for its actual mode."}</small></span>
    </section>
    <div className="live-index-boundary" role="note"><ShieldWarning/><span><strong>Indexing is not validation</strong><small>Embeddings and rankings organize source passages. They do not establish causality, efficacy, binding, safety, or toxicity.</small></span></div>
  </div>;
}

function Provenance({run}) { return <div className="live-provenance">{run.provenance?.map(item=><article key={item.sourceId}><CloudCheck/><div><h3>{item.sourceName}</h3><p>{item.query||item.queryType}</p><code>{item.endpoint}</code></div><dl><dt>Retrieved</dt><dd>{new Date(item.retrievedAt).toLocaleString()}</dd><dt>Licence</dt><dd>{item.license}</dd></dl></article>)}</div>; }

function capabilityState(name, value) {
  const structured = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  const explicitStatus = structured?.status ?? structured?.state;
  let status = explicitStatus;
  if (!present(status) && typeof value === "boolean") status = value ? "connected" : "not_configured";
  if (!present(status) && typeof value === "string") status = value;
  if (!present(status) && structured?.available === true) status = "available";
  if (!present(status) && structured?.available === false) status = "unavailable";
  if (!present(status) && structured?.configured === true) status = "configured";
  if (!present(status) && structured?.configured === false) status = "not_configured";
  status = status ?? "unavailable";
  let tone = statusTone(status);
  if (structured?.available === false || structured?.configured === false || value === false) tone = "unavailable";
  if (structured?.available === true && tone === "unavailable" && !explicitStatus) tone = "available";
  const reportedDetail = structured?.reason ?? structured?.message ?? structured?.detail;
  const detail = ["string", "number"].includes(typeof reportedDetail) ? String(reportedDetail) : value === true ? "Connected" : value === false ? "Not configured" : "No additional details reported";
  const metadata = [
    ["Provider", structured?.provider ?? structured?.service],
    ["Mode", structured?.mode],
    ["Model", structured?.model],
  ].filter(([, item])=>present(item) && typeof item !== "object");
  return { label: structured?.label ?? humanize(name), status: humanize(status), tone, detail, metadata };
}

function Capabilities({run}) {
  const entries = Object.entries(run.capabilities ?? {});
  if (!entries.length) return <Empty title="Capabilities unavailable" detail="This run did not report computational capability states."/>;
  return <div className="live-capabilities">{entries.map(([name,value])=>{
    const capability = capabilityState(name,value);
    return <article className={`is-${capability.tone}`} key={name}>
      <span className="live-capability-icon">{capability.tone === "available" ? <CheckCircle/> : capability.tone === "degraded" || capability.tone === "active" ? <Warning/> : <ShieldWarning/>}</span>
      <div className="live-capability-title"><strong>{capability.label}</strong><b>{capability.status}</b></div>
      <p>{capability.detail}</p>
      {capability.metadata.length > 0 && <dl>{capability.metadata.map(([label,item])=><div key={label}><dt>{label}</dt><dd>{item}</dd></div>)}</dl>}
    </article>;
  })}</div>;
}

function Empty({title,detail}) { return <div className="live-empty"><Database/><h3>{title}</h3><p>{detail}</p></div>; }

function RunView({run,onNewRun,user,onSignOut,accessToken}) {
  const [tab,setTab]=useState("Research"); const [selectedStage,setSelectedStage]=useState(run.stages?.[0]?.id);
  const score=run.association?.associationScore;
  const persistence=persistenceState(run.persistence);
  const selectStage=(stage)=>{setSelectedStage(stage.id);const destination={rag_index:"Index",evidence:"Evidence",literature:"Literature"}[stage.id];if(destination)setTab(destination);};
  const onTabKeyDown=(event,name)=>{
    const current=RUN_TABS.indexOf(name);
    let next=current;
    if(event.key==="ArrowRight")next=(current+1)%RUN_TABS.length;
    else if(event.key==="ArrowLeft")next=(current-1+RUN_TABS.length)%RUN_TABS.length;
    else if(event.key==="Home")next=0;
    else if(event.key==="End")next=RUN_TABS.length-1;
    else return;
    event.preventDefault();setTab(RUN_TABS[next]);event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')?.[next]?.focus();
  };
  const panel=tab==="Research"?<Research run={run} accessToken={accessToken}/>:tab==="Index"?<RagIndex run={run}/>:tab==="Evidence"?<EvidenceTable run={run}/>:tab==="Literature"?<Literature run={run}/>:tab==="Provenance"?<Provenance run={run}/>:<Capabilities run={run}/>;
  const download=()=>{const blob=new Blob([JSON.stringify(run,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`axiom-run-${run.id}.json`;a.click();URL.revokeObjectURL(url);};
  return <div className="live-run">
    <header className="live-header"><div className="live-brand"><Sparkle weight="fill"/><strong>Axiom Observatory</strong><span>REAL DATA</span></div><div className="live-run-id"><code>{run.id}</code><b>{run.status?.replaceAll("_"," ")}</b></div><div><button onClick={download}><DownloadSimple/> Export run</button><button onClick={onNewRun}><ArrowClockwise/> New run</button>{user&&<button title={user.email} onClick={onSignOut}><SignOut/> Sign out</button>}</div></header>
    <aside className="live-context"><label>Target context</label><h1>{run.target?.label}</h1><p>{run.target?.name||run.target?.id}</p><code>{run.target?.id}</code><hr/><h4>Disease</h4><h2>{run.disease?.label}</h2><code>{run.disease?.id}</code><hr/><h4>Evidence boundary</h4><p>This run retrieves and organizes evidence. It does not validate causality, binding, toxicity, or efficacy.</p><div className={`live-persistence ${persistence.durable?"is-durable":""}`}>{persistence.durable?<CloudCheck/>:<Warning/>}<span><strong>{persistence.durable?"Durable Supabase run":"Ephemeral run store"}</strong><small>{persistence.durable?"The versioned run snapshot is persisted in Supabase Postgres.":"Only the run ID is retained in this browser; the server record resets on restart."}</small></span></div></aside>
    <section className="live-workspace"><div className="live-workspace-title"><span>Evidence pipeline</span><small>Created {new Date(run.createdAt).toLocaleString()}</small></div><div className="live-stages">{run.stages?.map(stage=><StageCard key={stage.id} stage={stage} selected={stage.id===selectedStage} onClick={()=>selectStage(stage)}/>)}</div><div className="live-inspector"><nav aria-label="Run workspace" role="tablist">{RUN_TABS.map(name=>{const slug=name.toLowerCase();return <button type="button" role="tab" id={`live-tab-${slug}`} aria-controls={`live-panel-${slug}`} aria-selected={tab===name} tabIndex={tab===name?0:-1} className={tab===name?"is-active":""} onClick={()=>setTab(name)} onKeyDown={(event)=>onTabKeyDown(event,name)} key={name}>{name}{name==="Index"&&present(run.rag?.counts?.chunks)&&<span>{run.rag.counts.chunks}</span>}{name==="Evidence"&&<span>{run.evidence?.count??0}</span>}{name==="Literature"&&<span>{run.literature?.hitCount??0}</span>}</button>;})}</nav><div className="live-inspector-body" role="tabpanel" id={`live-panel-${tab.toLowerCase()}`} aria-labelledby={`live-tab-${tab.toLowerCase()}`} tabIndex={0}>{panel}</div></div></section>
    <aside className="live-decision"><label>Scientific judge</label><section className="live-score"><span>Association score</span><strong>{score==null?"—":Number(score).toFixed(3)}</strong><p>Upstream Open Targets ranking signal. It is not a confidence probability.</p></section><section><label>Direct evidence</label><h3>{run.evidence?.count??0} records</h3><p>{run.evidence?.pageNote}</p></section><section><label>Computational blockers</label>{run.stages?.filter(stage=>stage.status==="not_configured").map(stage=><div className="live-blocker" key={stage.id}><ShieldWarning/><span><strong>{stage.label}</strong><small>{stage.reason}</small></span></div>)}</section>{run.warnings?.length>0&&<section><label>Run warnings</label>{run.warnings.map(w=><p className="live-warning" key={w}>{w}</p>)}</section>}</aside>
    <footer className="live-footer"><span><i/> Evidence sources connected</span><span>Schema {run.schemaVersion}</span><span>Predictions are unavailable until validated workers are installed.</span><span>Open-source core · v0.4</span></footer>
  </div>;
}

export function LiveApp(){
  const [initialRunId,setInitialRunId]=useState(savedRunId);
  const [health,setHealth]=useState(null); const [run,setRun]=useState(null); const [restoring,setRestoring]=useState(Boolean(initialRunId)); const [error,setError]=useState("");
  const [auth,setAuth]=useState({loading:supabaseBrowserConfigured,session:null,user:null});
  const [recovery,setRecovery]=useState(false);
  const [authNotice,setAuthNotice]=useState("");
  const [authIssue,setAuthIssue]=useState("");
  const [authCallback,setAuthCallback]=useState(INITIAL_AUTH_CALLBACK);
  const callbackError=authCallback.error?authErrorMessage(authCallback.error):"";
  const clearAuthCallback=()=>{clearAuthCallbackLocation();setAuthCallback({intent:null,error:null,isAuthRoute:false,hasAuthResponse:false});};
  useEffect(()=>{
    let active=true;
    api.health().then(value=>active&&setHealth(value)).catch(e=>{if(active){setError(e.message);setRestoring(false);}});
    return()=>{active=false;};
  },[]);
  useEffect(()=>{
    if(!supabase){setAuth({loading:false,session:null,user:null});return undefined;}
    let active=true; let callbackExchangePending=authCallback.hasAuthResponse&&!authCallback.error;
    const {data:{subscription}}=supabase.auth.onAuthStateChange((event,session)=>{
      if(!active)return;
      const verifiedRecovery=event==="PASSWORD_RECOVERY";
      setAuth({loading:callbackExchangePending,session,user:session?.user??null});
      if(verifiedRecovery)setRecovery(true);
    });
    const initialize=async()=>{
      if(callbackExchangePending){
        try {
          const exchange=exchangeAuthCallback(supabase);
          clearAuthCallbackLocation();
          const data=await exchange;
          if(!active)return;
          callbackExchangePending=false;
          const intent=authIntentFromRedirectType(data.redirectType);
          if(authCallback.intent==="recovery"&&intent!=="recovery"){
            setRecovery(false);
            setAuthCallback(current=>({...current,hasAuthResponse:false,error:{code:"invalid_recovery_callback",message:"This link did not create a recovery session."}}));
          }else{
            if(intent==="recovery")setRecovery(true);
            setAuthCallback(current=>({...current,intent,error:null,hasAuthResponse:false}));
          }
          setAuth({loading:false,session:data.session,user:data.session?.user??null});
        }catch(exchangeError){
          callbackExchangePending=false;clearAuthCallbackLocation();
          const {data}=await supabase.auth.getSession();
          if(!active)return;
          setRecovery(false);
          setAuth({loading:false,session:data.session,user:data.session?.user??null});
          setAuthCallback(current=>({...current,hasAuthResponse:false,error:{code:exchangeError?.code??"callback_exchange_failed",message:exchangeError?.message??"Authentication could not be completed."}}));
        }
        return;
      }
      const {data}=await supabase.auth.getSession();
      if(active)setAuth({loading:false,session:data.session,user:data.session?.user??null});
    };
    initialize().catch(()=>active&&setAuth({loading:false,session:null,user:null}));
    return()=>{active=false;subscription.unsubscribe();};
  },[]);
  useEffect(()=>{
    if(auth.loading||!authCallback.isAuthRoute)return;
    if(authCallback.error){if(auth.session)setAuthIssue(authErrorMessage(authCallback.error));clearAuthCallbackLocation();return;}
    if(authCallback.intent!=="recovery"&&auth.session){
      setAuthIssue("");
      setAuthNotice(authSuccessMessage(authCallback.intent));
      clearAuthCallback();
    }
  },[auth.loading,auth.session]);
  useEffect(()=>{if(recovery)clearAuthCallbackLocation();},[recovery]);
  useEffect(()=>{
    if(!health||auth.loading||recovery)return undefined;
    if(!initialRunId){setRestoring(false);return undefined;}
    if(health.authRequired&&!auth.session){setRestoring(false);setRun(null);return undefined;}
    let active=true; setRestoring(true);
    api.getRun(initialRunId,auth.session?.access_token).then(value=>{if(active)setRun(value);}).catch(e=>{if(active){localStorage.removeItem(SAVED_RUN_KEY);setInitialRunId(null);setError(`Saved run could not be restored: ${e.message}`);}}).finally(()=>active&&setRestoring(false));
    return()=>{active=false;};
  },[health,auth.loading,auth.session?.access_token,initialRunId,recovery]);
  const signOut=async()=>{if(supabase)await supabase.auth.signOut();setRun(null);setRecovery(false);setAuthNotice("");setAuthIssue("");clearAuthCallback();};
  const finishRecovery=()=>{setRecovery(false);setAuthIssue("");setAuthNotice("Password updated. Your protected workspace is ready.");clearAuthCallback();};
  const createRun=async input=>{const next=await api.createRun(input,auth.session?.access_token);localStorage.setItem(SAVED_RUN_KEY,JSON.stringify(next.id));setRun(next);};
  if((health?.authRequired||recovery||authCallback.isAuthRoute)&&auth.loading) return <main className="live-shell live-restoring"><LockKey/><strong>Checking Supabase session</strong><small>Restoring the authenticated workspace…</small></main>;
  if(health?.authRequired&&!supabaseBrowserConfigured) return <AuthConfigurationMissing/>;
  if(recovery&&auth.session) return <PasswordRecoveryPanel onComplete={finishRecovery} onCancel={signOut}/>;
  if((recovery&&!auth.session)||(authCallback.intent==="recovery"&&!recovery)) return <AuthPanel initialMode="reset" initialError={callbackError||"This recovery link is invalid or has expired. Request a new one."} onLeaveCallback={()=>{setRecovery(false);clearAuthCallback();}}/>;
  if(restoring) return <main className="live-shell live-restoring"><CloudCheck/><strong>Restoring evidence run</strong><small>Loading the authoritative server record…</small></main>;
  if(health?.authRequired&&!auth.session) return <AuthPanel initialError={callbackError} onLeaveCallback={clearAuthCallback}/>;
  if(run) return <><AuthNotice message={authIssue||authNotice} tone={authIssue?"error":"success"} onDismiss={()=>authIssue?setAuthIssue(""):setAuthNotice("")}/><RunView run={run} onNewRun={()=>{localStorage.removeItem(SAVED_RUN_KEY);setInitialRunId(null);setRun(null);}} user={auth.user} onSignOut={signOut} accessToken={auth.session?.access_token}/></>;
  return <main className="live-shell"><AuthNotice message={authIssue||authNotice} tone={authIssue?"error":"success"} onDismiss={()=>authIssue?setAuthIssue(""):setAuthNotice("")}/>{error&&<div className="live-global-error">API unavailable: {error}</div>}<Setup health={health} onRun={createRun} user={auth.user} onSignOut={signOut}/></main>;
}
