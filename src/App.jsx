import { useState } from 'react';
import {
  ArrowSquareOut, Bell, Check, CheckCircle, Flask, MagnifyingGlass,
  Pause, Play, ShieldWarning, Sparkle, SquaresFour, Warning,
} from '@phosphor-icons/react';

const lanes = [
  { id: 'evidence', n: 1, title: 'Evidence', service: 'Europe PMC retrieval', detail: 'Retrieving TNIK and fibrosis experimental evidence.', source: 'PMID: 35367938', confidence: .78, tone: 'violet', status: 'Running' },
  { id: 'skeptic', n: 2, title: 'Skeptic', service: 'Open Targets evidence', detail: 'Assessing tractability, genetics, and known liabilities.', source: 'ot_genetics.json v1.2.1', confidence: .71, tone: 'violet', status: 'Running' },
  { id: 'docking', n: 3, title: 'Docking', service: 'Vina redocking', detail: 'Re-docking known ligands to TNIK crystal structure.', source: 'tnik_vina_redock.csv', confidence: .68, tone: 'teal', status: 'Completed' },
  { id: 'safety', n: 4, title: 'Safety', service: 'ADMET-AI', detail: 'Predicting ADMET liabilities and safety risks.', source: 'admet_ai_v2.1.0', confidence: .42, tone: 'coral', status: 'Running' },
];

const endpoints = [
  ['hERG IKr inhibition', 'pIC50 6.21', '.62', 'High risk'],
  ['Ames mutagenicity', 'Positive', '.71', 'High risk'],
  ['Hepatotoxicity', 'High', '.66', 'High risk'],
  ['DILI', 'Moderate', '.58', 'Caution'],
  ['Nephrotoxicity', 'Low', '.71', 'OK'],
  ['CYP3A4 inhibition', 'Moderate', '.65', 'Caution'],
  ['Plasma protein binding', 'High', '.84', 'OK'],
];

function Lane({ lane, selected, onSelect }) {
  return <button className={`lane ${lane.tone} ${selected ? 'selected' : ''}`} onClick={() => onSelect(lane.id)}>
    <div className="lane-title"><span className="lane-index">{lane.n}</span><strong>{lane.title}</strong><span>{lane.status}</span></div>
    <div className="progress"><i style={{width: `${lane.confidence * 100}%`}} /></div>
    <h3>{lane.service}</h3><p>{lane.detail}</p>
    <span className="evidence-tag">{lane.id === 'docking' || lane.id === 'safety' ? 'Computational prediction' : 'Experimental evidence'}</span>
    <dl><dt>Source</dt><dd>{lane.source}</dd><dt>Confidence</dt><dd className="confidence">{lane.confidence.toFixed(2)} <i style={{width: `${lane.confidence*100}%`}} /></dd></dl>
  </button>
}

function Radar() {
  return <div className="radar-wrap" aria-label="ADMET profile radar chart">
    <svg viewBox="0 0 320 260" role="img">
      <g className="radar-grid"><polygon points="160,24 279,103 233,232 87,232 41,103"/><polygon points="160,63 240,116 209,202 111,202 80,116"/><polygon points="160,102 201,129 185,173 135,173 119,129"/>
      <line x1="160" y1="24" x2="160" y2="173"/><line x1="279" y1="103" x2="135" y2="173"/><line x1="233" y1="232" x2="119" y2="129"/><line x1="87" y1="232" x2="201" y2="129"/><line x1="41" y1="103" x2="185" y2="173"/></g>
      <polygon className="radar-training" points="160,72 231,120 218,207 104,211 67,112"/>
      <polygon className="radar-query" points="160,58 249,112 218,214 99,209 55,105"/>
      <g className="radar-labels"><text x="160" y="14">Absorption</text><text x="286" y="103">Distribution</text><text x="242" y="250">Metabolism</text><text x="65" y="250">Excretion</text><text x="4" y="103">Toxicity</text></g>
    </svg>
    <div className="legend"><span className="query">Predicted (query compound)</span><span className="training">Training domain (95% coverage)</span></div>
  </div>
}

export function App() {
  const [selected, setSelected] = useState('safety');
  const [tab, setTab] = useState('Safety inspection');
  const [paused, setPaused] = useState(false);
  const [resolved, setResolved] = useState(false);
  const active = lanes.find(l => l.id === selected);
  return <main className="app-shell">
    <header>
      <div className="brand"><Sparkle weight="fill"/> Axiom Observatory <span>Open-source POC</span></div>
      <div className="run-meta"><span>RUN-2026-08-01-0017</span><b className={paused ? 'paused' : ''}>{paused ? 'PAUSED' : 'RUNNING'}</b><span>Elapsed&nbsp; 00:18:47</span></div>
      <div className="header-actions"><button><ArrowSquareOut/> Inspect raw evidence</button><button onClick={()=>setPaused(!paused)}>{paused ? <Play/> : <Pause/>}{paused ? 'Resume run' : 'Pause run'}</button><Bell/><span className="avatar">GK</span></div>
    </header>

    <aside className="context-panel">
      <section><label>Target context</label><h1>TNIK</h1><p>TRAF2 and NCK interacting kinase</p><hr/><h4>Therapeutic hypothesis</h4><p>Inhibition of TNIK reverses fibrotic signaling programs and extracellular matrix deposition in lung and hepatic fibrosis.</p><h4>Indication focus</h4><p>Idiopathic Pulmonary Fibrosis (IPF)<br/>Liver Fibrosis</p></section>
      <section><label>Progression criteria</label>
        <div className="criterion done"><CheckCircle/>High-confidence experimental evidence linking TNIK to fibrosis.</div>
        <div className="criterion done"><CheckCircle/>Computational support for tractability and ligandability.</div>
        <div className={`criterion ${resolved ? 'done' : 'blocked'}`}>{resolved ? <CheckCircle/> : <Warning/>}Favorable safety profile with no critical ADMET blockers.</div>
        <div className="criterion"><span className="step">4</span>Consensus across agents with no unresolved high-severity conflicts.</div>
      </section>
      <section className="mini"><label>Knowledge & models</label><p>Evidence KB snapshot<br/><strong>2026-08-01 09:12 UTC</strong></p><p>Models registry<br/><strong>v2026.08 (Latest)</strong></p></section>
    </aside>

    <section className="workspace">
      <div className="workspace-title"><span>Agentic validation run</span><button><SquaresFour/> View run graph</button></div>
      <div className="lanes">{lanes.map(l=><Lane key={l.id} lane={l} selected={selected===l.id} onSelect={setSelected}/>)}</div>

      <div className="inspection">
        <nav>{['Agent reasoning','Live console','Outputs','Safety inspection'].map(t=><button className={tab===t?'active':''} onClick={()=>setTab(t)} key={t}>{t}</button>)}</nav>
        {tab === 'Safety inspection' ? <div className="inspection-grid">
          <section className="admet"><label>ADMET profile</label><Radar/><div className="domain-warning"><Warning/><div><b>Applicability domain: outside</b><p>Predictions may be unreliable for this chemical space.</p></div><button>View domain analysis</button></div></section>
          <section className="endpoints"><label>Safety endpoints</label><div className="table-head"><span>Endpoint</span><span>Prediction</span><span>Confidence</span><span>Status</span></div>{endpoints.map(([a,b,c,d])=><div className="table-row" key={a}><span>{a}</span><b>{b}</b><span>{c}</span><span className={d==='High risk'?'risk':d==='Caution'?'caution':'ok'}>{d}</span></div>)}</section>
          <section className="provenance"><label>Provenance</label>{[['Model','ADMET-AI 2.1'],['Model version','admet_ai_v2.1.0'],['Trained on','ChEMBL 33, Tox21, DILIrank'],['Inference time','2026-08-01 09:31:14'],['Input','SMILES (canonical)'],['Raw results','admet_run_0017.json'],['Environment','Docker sha256:7f3a…'],['License','Apache-2.0']].map(r=><div key={r[0]}><span>{r[0]}</span><b>{r[1]}</b></div>)}<p><strong>Notes</strong><br/>Outside applicability domain for toxicity and metabolism. Interpret with caution and consider orthogonal assays.</p></section>
        </div> : <div className="tab-placeholder"><div className="orb"><MagnifyingGlass/></div><h2>{tab}</h2><p>{active.title} agent · {active.service}</p><pre>{`[09:31:08] source resolved\n[09:31:11] artifact versioned\n[09:31:14] confidence ${active.confidence.toFixed(2)}\n[09:31:16] awaiting scientific judge`}</pre></div>}
      </div>
    </section>

    <aside className="decision-panel">
      <label>Decision rail</label><section className="blocker-count"><strong>{resolved ? 0 : 3}</strong><span>blockers before<br/>progression</span>{resolved ? <div className="resolved"><Check/> Resolved for POC</div> : <><div>High risk hERG IKr inhibition</div><div>Ames mutagenicity predicted positive</div><div>High predicted hepatotoxicity</div></>}</section>
      <section><label>Next action</label><p>{resolved ? 'The computational blockers are acknowledged. Experimental confirmation is still required.' : 'Address blockers or obtain new evidence to meet progression criteria.'}</p><button className="primary" onClick={()=>setResolved(!resolved)}>{resolved ? 'Reopen blockers' : 'Resolve blockers'}</button></section>
      <section><label>Supporting actions</label><button><ArrowSquareOut/> Inspect raw evidence</button><button onClick={()=>setPaused(!paused)}>{paused?<Play/>:<Pause/>}{paused?'Resume run':'Pause run'}</button></section>
      <section className="summary"><label>Run summary</label><dl><dt>Agents</dt><dd>4 of 4</dd><dt>Completed</dt><dd>1</dd><dt>Running</dt><dd>{paused?0:3}</dd><dt>Blocked</dt><dd>{resolved?0:1}</dd><dt>Agreement</dt><dd>0.56</dd></dl></section>
    </aside>
    <footer><span><i/> All systems nominal</span><span>Data as of 2026-08-01 09:31 UTC</span><span>All outputs and logs are versioned and publicly reproducible.</span><span>Open-source POC&nbsp; · &nbsp;Apache-2.0</span></footer>
  </main>
}
