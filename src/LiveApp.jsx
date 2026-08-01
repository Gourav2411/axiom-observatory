import { useEffect, useState } from "react";
import {
  ArrowClockwise, ArrowSquareOut, CheckCircle, CloudCheck, Database,
  DownloadSimple, Flask, LockKey, MagnifyingGlass, Play, ShieldWarning, SignOut,
  Sparkle, UserCircle, Warning,
} from "@phosphor-icons/react";
import { api } from "./api.js";
import { supabase, supabaseBrowserConfigured } from "./supabase.js";

const SAVED_RUN_KEY = "axiom:last-evidence-run";

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

function StageCard({ stage, selected, onClick }) {
  const status = stage.status ?? "unknown";
  return <button className={`live-stage live-${status} ${selected ? "is-selected" : ""}`} onClick={onClick}>
    <div className="live-stage-head"><span>{stage.id === "evidence" ? <Database/> : stage.id === "literature" ? <MagnifyingGlass/> : <Flask/>}</span><strong>{stage.label}</strong><i>{status.replaceAll("_", " ")}</i></div>
    <h3>{stage.service}</h3>
    <p>{stage.reason ?? `${stage.itemCount ?? 0} retrieved records`}</p>
    <footer>{stage.evidenceKind?.replaceAll("_", " ") ?? "service state"}</footer>
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

function AuthPanel() {
  const [mode,setMode]=useState("sign-in"); const [email,setEmail]=useState(""); const [password,setPassword]=useState("");
  const [loading,setLoading]=useState(false); const [error,setError]=useState(""); const [message,setMessage]=useState("");
  const submit=async(event)=>{
    event.preventDefault(); setLoading(true); setError(""); setMessage("");
    try {
      const action=mode==="sign-in"?supabase.auth.signInWithPassword({email,password}):supabase.auth.signUp({email,password});
      const {data,error:authError}=await action;
      if(authError)setError(authError.message);
      else if(mode==="sign-up"&&!data.session)setMessage("Check your email to confirm the account, then sign in.");
    } catch(authError) {
      setError(authError.message||"Supabase Auth is unavailable.");
    } finally {
      setLoading(false);
    }
  };
  return <main className="live-shell live-auth"><section><span className="live-kicker"><LockKey/> Protected workspace</span><h1>Sign in to durable research.</h1><p>Supabase Auth protects workspace-owned evidence runs. Your browser token is forwarded to the API; the service-role credential remains server-only.</p><form onSubmit={submit}><label>Email<input type="email" value={email} onChange={(event)=>setEmail(event.target.value)} autoComplete="email" required/></label><label>Password<input type="password" value={password} onChange={(event)=>setPassword(event.target.value)} autoComplete={mode==="sign-in"?"current-password":"new-password"} minLength="10" required/></label>{error&&<div className="live-error"><Warning/>{error}</div>}{message&&<div className="live-auth-message"><CheckCircle/>{message}</div>}<button className="live-primary" disabled={loading}>{loading?"Authenticating…":mode==="sign-in"?"Sign in":"Create account"}</button></form><button className="live-auth-switch" onClick={()=>{setMode(mode==="sign-in"?"sign-up":"sign-in");setError("");setMessage("");}}>{mode==="sign-in"?"Need an account? Create one":"Already registered? Sign in"}</button></section></main>;
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

function Research({ run, accessToken }) {
  const [question, setQuestion] = useState(`What evidence links ${run.target?.label ?? "this target"} to ${run.disease?.label ?? "this disease"}?`);
  const [retrieval, setRetrieval] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    const query = question.trim();
    if (query.length < 3 || loading) return;
    setLoading(true);
    setError("");
    try {
      setRetrieval(await api.retrieveRun(run.id, { query, topK: 8 }, accessToken));
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
      <small id="live-research-help">Lexical ranking across this run's evidence records and literature metadata.</small>
    </form>
    {error && <div className="live-error" role="alert"><Warning/><span><strong>Retrieval failed</strong><small>{error}</small></span></div>}
    {loading && <div className="live-retrieval-loading" role="status" aria-live="polite"><span/><p>Ranking grounded passages…</p></div>}
    {!loading && retrieval && <section className="live-retrieval-results" aria-live="polite">
      <header><div><span>{retrieval.results?.length ?? 0} ranked passages</span><small>{retrieval.totalCandidates ?? 0} candidates · {(retrieval.retrievalMode ?? "retrieval").replaceAll("_", " ")}</small></div><strong>{retrieval.generated === false ? "Retrieval only" : "Generated output"}</strong></header>
      {retrieval.warnings?.map((warning)=><p className="live-retrieval-warning" key={warning}><Warning/>{warning}</p>)}
      {(retrieval.results?.length ?? 0) === 0 ? <Empty title="No matching passages" detail="Try a more specific target, mechanism, study, or disease phrase."/> : <div className="live-retrieval-list">{retrieval.results.map((result, index)=><article key={result.id}>
        <div className="live-retrieval-rank"><span>{String(index + 1).padStart(2, "0")}</span><strong>{Number(result.score ?? 0).toFixed(3)}</strong></div>
        <div className="live-retrieval-copy"><div><span>{result.sourceType?.replaceAll("_", " ") ?? "source"}</span>{result.citations?.slice(0, 3).map((citation)=><code key={citation}>{citation}</code>)}</div><h3>{result.title || "Untitled source record"}</h3><p>{result.excerpt || "No excerpt returned."}</p>{result.sourceUrl && <a href={result.sourceUrl} target="_blank" rel="noreferrer">Open source record <ArrowSquareOut/></a>}</div>
      </article>)}</div>}
    </section>}
    {!loading && !retrieval && <div className="live-research-empty"><Database/><p>Enter a question to retrieve the most relevant grounded passages from this run.</p></div>}
  </div>;
}

function Provenance({run}) { return <div className="live-provenance">{run.provenance?.map(item=><article key={item.sourceId}><CloudCheck/><div><h3>{item.sourceName}</h3><p>{item.query||item.queryType}</p><code>{item.endpoint}</code></div><dl><dt>Retrieved</dt><dd>{new Date(item.retrievedAt).toLocaleString()}</dd><dt>Licence</dt><dd>{item.license}</dd></dl></article>)}</div>; }

function Capabilities({run}) { return <div className="live-capabilities">{Object.entries(run.capabilities??{}).map(([name,available])=><div className={available?"available":"unavailable"} key={name}><span>{available?<CheckCircle/>:<ShieldWarning/>}</span><strong>{name}</strong><small>{available?"Connected":"Not configured"}</small></div>)}</div>; }

function Empty({title,detail}) { return <div className="live-empty"><Database/><h3>{title}</h3><p>{detail}</p></div>; }

function RunView({run,onNewRun,user,onSignOut,accessToken}) {
  const [tab,setTab]=useState("Research"); const [selectedStage,setSelectedStage]=useState(run.stages?.[0]?.id);
  const score=run.association?.associationScore;
  const persistence=persistenceState(run.persistence);
  const download=()=>{const blob=new Blob([JSON.stringify(run,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`axiom-run-${run.id}.json`;a.click();URL.revokeObjectURL(url);};
  return <div className="live-run">
    <header className="live-header"><div className="live-brand"><Sparkle weight="fill"/><strong>Axiom Observatory</strong><span>REAL DATA</span></div><div className="live-run-id"><code>{run.id}</code><b>{run.status?.replaceAll("_"," ")}</b></div><div><button onClick={download}><DownloadSimple/> Export run</button><button onClick={onNewRun}><ArrowClockwise/> New run</button>{user&&<button title={user.email} onClick={onSignOut}><SignOut/> Sign out</button>}</div></header>
    <aside className="live-context"><label>Target context</label><h1>{run.target?.label}</h1><p>{run.target?.name||run.target?.id}</p><code>{run.target?.id}</code><hr/><h4>Disease</h4><h2>{run.disease?.label}</h2><code>{run.disease?.id}</code><hr/><h4>Evidence boundary</h4><p>This run retrieves and organizes evidence. It does not validate causality, binding, toxicity, or efficacy.</p><div className={`live-persistence ${persistence.durable?"is-durable":""}`}>{persistence.durable?<CloudCheck/>:<Warning/>}<span><strong>{persistence.durable?"Durable Supabase run":"Ephemeral run store"}</strong><small>{persistence.durable?"The versioned run snapshot is persisted in Supabase Postgres.":"Only the run ID is retained in this browser; the server record resets on restart."}</small></span></div></aside>
    <section className="live-workspace"><div className="live-workspace-title"><span>Evidence pipeline</span><small>Created {new Date(run.createdAt).toLocaleString()}</small></div><div className="live-stages">{run.stages?.map(stage=><StageCard key={stage.id} stage={stage} selected={stage.id===selectedStage} onClick={()=>setSelectedStage(stage.id)}/>)}</div><div className="live-inspector"><nav aria-label="Run workspace">{["Research","Evidence","Literature","Provenance","Capabilities"].map(name=><button className={tab===name?"is-active":""} onClick={()=>setTab(name)} key={name} aria-current={tab===name?"page":undefined}>{name}{name==="Evidence"&&<span>{run.evidence?.count??0}</span>}{name==="Literature"&&<span>{run.literature?.hitCount??0}</span>}</button>)}</nav><div className="live-inspector-body">{tab==="Research"?<Research run={run} accessToken={accessToken}/>:tab==="Evidence"?<EvidenceTable run={run}/>:tab==="Literature"?<Literature run={run}/>:tab==="Provenance"?<Provenance run={run}/>:<Capabilities run={run}/>}</div></div></section>
    <aside className="live-decision"><label>Scientific judge</label><section className="live-score"><span>Association score</span><strong>{score==null?"—":Number(score).toFixed(3)}</strong><p>Upstream Open Targets ranking signal. It is not a confidence probability.</p></section><section><label>Direct evidence</label><h3>{run.evidence?.count??0} records</h3><p>{run.evidence?.pageNote}</p></section><section><label>Computational blockers</label>{run.stages?.filter(stage=>stage.status==="not_configured").map(stage=><div className="live-blocker" key={stage.id}><ShieldWarning/><span><strong>{stage.label}</strong><small>{stage.reason}</small></span></div>)}</section>{run.warnings?.length>0&&<section><label>Run warnings</label>{run.warnings.map(w=><p className="live-warning" key={w}>{w}</p>)}</section>}</aside>
    <footer className="live-footer"><span><i/> Evidence sources connected</span><span>Schema {run.schemaVersion}</span><span>Predictions are unavailable until validated workers are installed.</span><span>Open-source core · v0.2</span></footer>
  </div>;
}

export function LiveApp(){
  const [initialRunId,setInitialRunId]=useState(savedRunId);
  const [health,setHealth]=useState(null); const [run,setRun]=useState(null); const [restoring,setRestoring]=useState(Boolean(initialRunId)); const [error,setError]=useState("");
  const [auth,setAuth]=useState({loading:supabaseBrowserConfigured,session:null,user:null});
  useEffect(()=>{
    let active=true;
    api.health().then(value=>active&&setHealth(value)).catch(e=>{if(active){setError(e.message);setRestoring(false);}});
    return()=>{active=false;};
  },[]);
  useEffect(()=>{
    if(!supabase){setAuth({loading:false,session:null,user:null});return undefined;}
    let active=true;
    supabase.auth.getSession().then(({data})=>{if(active)setAuth({loading:false,session:data.session,user:data.session?.user??null});});
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,session)=>{if(active)setAuth({loading:false,session,user:session?.user??null});});
    return()=>{active=false;subscription.unsubscribe();};
  },[]);
  useEffect(()=>{
    if(!health||auth.loading)return undefined;
    if(!initialRunId){setRestoring(false);return undefined;}
    if(health.authRequired&&!auth.session){setRestoring(false);setRun(null);return undefined;}
    let active=true; setRestoring(true);
    api.getRun(initialRunId,auth.session?.access_token).then(value=>{if(active)setRun(value);}).catch(e=>{if(active){localStorage.removeItem(SAVED_RUN_KEY);setInitialRunId(null);setError(`Saved run could not be restored: ${e.message}`);}}).finally(()=>active&&setRestoring(false));
    return()=>{active=false;};
  },[health,auth.loading,auth.session?.access_token,initialRunId]);
  const signOut=async()=>{if(supabase)await supabase.auth.signOut();setRun(null);};
  const createRun=async input=>{const next=await api.createRun(input,auth.session?.access_token);localStorage.setItem(SAVED_RUN_KEY,JSON.stringify(next.id));setRun(next);};
  if(restoring) return <main className="live-shell live-restoring"><CloudCheck/><strong>Restoring evidence run</strong><small>Loading the authoritative server record…</small></main>;
  if(health?.authRequired&&auth.loading) return <main className="live-shell live-restoring"><LockKey/><strong>Checking Supabase session</strong><small>Restoring the authenticated workspace…</small></main>;
  if(health?.authRequired&&!supabaseBrowserConfigured) return <AuthConfigurationMissing/>;
  if(health?.authRequired&&!auth.session) return <AuthPanel/>;
  if(run) return <RunView run={run} onNewRun={()=>{localStorage.removeItem(SAVED_RUN_KEY);setInitialRunId(null);setRun(null);}} user={auth.user} onSignOut={signOut} accessToken={auth.session?.access_token}/>;
  return <main className="live-shell">{error&&<div className="live-global-error">API unavailable: {error}</div>}<Setup health={health} onRun={createRun} user={auth.user} onSignOut={signOut}/></main>;
}
