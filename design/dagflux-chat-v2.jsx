// ── Dagflux Chat Assistant v2 ────────────────────────────────────
// Global helper assistant (popup + expanded). Mounts to #chat-root.
// Requires dagflux-shared.jsx + dagflux-nodes.jsx (for ND/icons).

const { useState: useCv2S, useRef: useCv2R, useEffect: useCv2E, useMemo: useCv2M } = React;
const { DG_C: V, DG_MONO: VM, DG_SANS: VS, DG_I: VI, DG_ND: VND, NODE_ICO_MAP: VICO } = window;

// ── Sample conversations ─────────────────────────────────────────
const V_CONVOS = [
  { id:'c1', title:'Top customers — Q1 revenue',     preview:'Show me top 10 customers by revenue this quarter',           date:'Today · 9:43 AM', group:'Today',         status:'completed' },
  { id:'c2', title:'90-day churn pipeline',           preview:'Build a workflow that analyses churn over 90 days…',         date:'Today · 8:13 AM', group:'Today',         status:'plan' },
  { id:'c3', title:'Salesforce CRM auth failure',     preview:'Why is the Salesforce connector failing on auth?',           date:'Today · 7:55 AM', group:'Today',         status:'completed' },
  { id:'c4', title:'Daily Reports — last 30d filter', preview:'Add a filter for last 30 days only on the daily report',     date:'Yesterday',       group:'Yesterday' },
  { id:'c5', title:'Order Sync output schema',        preview:'Summarise the join output schema for orders+customers',      date:'Yesterday',       group:'Yesterday' },
  { id:'c6', title:'Revenue forecast viz',            preview:'Visualise expected revenue for next quarter',                date:'Apr 21',          group:'Last 7 days' },
  { id:'c7', title:'Customer cohort export',          preview:'Export Q1 cohort analysis to CSV',                           date:'Apr 19',          group:'Last 7 days' },
  { id:'c8', title:'Stripe webhook integration',      preview:'Connect Stripe webhook events to the warehouse',             date:'Apr 12',          group:'Older' },
  { id:'c9', title:'PII masking transformer',         preview:'Add PII masking to the analytics export',                    date:'Apr 04',          group:'Older' },
];

const V_CHATS = {
  c1: [
    { role:'bot',  text:"Hi — I'm your Dagflux assistant. I can answer questions about your workflows, connections, edit pipelines on the canvas, and visualise results. What would you like to explore?", ts:'9:40 AM' },
    { role:'user', text:'Show me top 10 customers by revenue this quarter.', ts:'9:42 AM' },
    { role:'bot',
      text:"Here are the top customers from **orders_enriched** for Q1 2026. Total Q1 revenue across these 10 accounts is **$221,470** — about **38% of pipeline revenue**.",
      sources:['analytics.orders_enriched','crm.customers'],
      sql:`SELECT c.customer_id, c.name, SUM(o.revenue) AS revenue, COUNT(*) AS orders\nFROM analytics.orders_enriched o\nJOIN crm.customers c USING (customer_id)\nWHERE o.order_date >= '2026-01-01'\nGROUP BY c.customer_id, c.name\nORDER BY revenue DESC\nLIMIT 10`,
      table:{
        cols:['customer_id','name','revenue','orders'],
        rows:[
          {customer_id:'C-1042', name:'Sarah Chen',     revenue:'$48,210', orders:42},
          {customer_id:'C-0391', name:'Marcus Webb',    revenue:'$32,058', orders:31},
          {customer_id:'C-2187', name:'Priya Mehta',    revenue:'$29,107', orders:28},
          {customer_id:'C-0054', name:'James Park',     revenue:'$24,402', orders:25},
          {customer_id:'C-1199', name:'Ana Sousa',      revenue:'$19,821', orders:22},
        ]
      },
      ts:'9:42 AM' },
    { role:'user', text:'Visualise this as a bar chart.', ts:'9:43 AM' },
    { role:'bot',
      text:'Here is the revenue distribution. **Sarah Chen** leads with **$48,210** — roughly **22%** of top-10 revenue.',
      chart:{ type:'bar', title:'Revenue · top 10 customers · Q1', unit:'$',
        data:[
          {label:'Sarah C.',  value:48210},
          {label:'Marcus W.', value:32058},
          {label:'Priya M.',  value:29107},
          {label:'James P.',  value:24402},
          {label:'Ana S.',    value:19821},
          {label:'Tomás L.',  value:17350},
          {label:'Mei K.',    value:15990},
          {label:'Diego R.',  value:13412},
          {label:'Liam O.',   value:11280},
          {label:'Yumi T.',   value: 9820},
        ]},
      ts:'9:43 AM' },
  ],
  c2: [
    { role:'bot',  text:"Hi — I'm your Dagflux assistant.", ts:'8:10 AM' },
    { role:'user', text:'Build a pipeline that analyses churn for the last 90 days, joins it with subscription data, and exports a daily report.', ts:'8:11 AM' },
    { role:'bot',
      text:"Got it — that's a multi-step task. I've drafted an execution plan based on your existing connections and the **subscriptions** + **customer_activity** tables. Review the steps, then I can build the workflow on the canvas.",
      plan:{
        title:'Churn analysis pipeline · last 90 days',
        confidence:0.92,
        estimated:'~12s · 6 nodes',
        steps:[
          { type:'dataSource',  title:'Pull customer activity',     desc:'Read orders + activity from Postgres, filter to last 90 days' },
          { type:'dataSource',  title:'Pull subscriptions',         desc:'Read active subs from Stripe via warehouse mirror' },
          { type:'transformer', title:'Compute churn signals',      desc:'Days since last order, MRR delta, support ticket count' },
          { type:'join',        title:'Join on customer_id',        desc:'Left-join activity → subscriptions, preserve no-sub rows' },
          { type:'branch',      title:'Validate & branch VIPs',     desc:'Drop rows w/o customer match, route VIPs to alert path' },
          { type:'output',      title:'Export daily report',        desc:'Write /reports/churn_daily.csv on schedule 06:00 UTC' },
        ],
      },
      ts:'8:13 AM' },
  ],
  c3: [
    { role:'bot',  text:"Hi — I'm your Dagflux assistant.", ts:'7:54 AM' },
    { role:'user', text:'Why is the Salesforce CRM connector failing on auth?', ts:'7:55 AM' },
    { role:'bot',
      text:"I checked your **Connections**. The Salesforce CRM connector is using an OAuth token that **expired 2 days ago**. The refresh path isn't being used because the connection has `auto_refresh: false`.",
      stat:{ label:'Connection · salesforce_crm', value:'Auth failed', sub:'Last successful sync 2d 4h ago · 14 retries · token expired Apr 21' },
      actions:[
        { label:'Reauthorize Salesforce', primary:true, icon:'play' },
        { label:'Enable auto-refresh',    icon:'check' },
        { label:'Open connector logs',    icon:'history' },
      ],
      ts:'7:55 AM' },
  ],
  c4: [
    { role:'bot',  text:"Hi — I'm your Dagflux assistant.", ts:'2:14 PM' },
    { role:'user', text:'Add a filter for last 30 days only on the daily report.', ts:'2:15 PM' },
    { role:'bot',
      text:"I've added a **Transformer** node before the output that filters `report_date >= CURRENT_DATE - 30`. The change is staged — review on the canvas before running.",
      ts:'2:15 PM' },
  ],
};

// ── Bold + inline-code renderer ──────────────────────────────────
const VBold = ({text}) => {
  if (!text) return null;
  return text.split(/(\*\*.*?\*\*|`[^`]*`)/g).map((p,i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i} style={{fontWeight:700}}>{p.slice(2,-2)}</strong>;
    if (p.startsWith('`')  && p.endsWith('`'))  return <code key={i} style={{fontFamily:VM,fontSize:11,background:V.s2,padding:'1px 5px',borderRadius:3,border:`1px solid ${V.border}`}}>{p.slice(1,-1)}</code>;
    return <span key={i}>{p}</span>;
  });
};

// ── SQL collapsible ──────────────────────────────────────────────
const VSql = ({sql}) => {
  const [o,sO] = useCv2S(false);
  return (
    <div style={{marginTop:8}}>
      <div onClick={()=>sO(!o)} style={{display:'inline-flex',alignItems:'center',gap:6,cursor:'pointer',padding:'4px 9px',borderRadius:4,background:V.surface,border:`1px solid ${V.border}`}}>
        {VI('code',V.muted,11)}
        <span style={{fontSize:9,fontFamily:VM,fontWeight:700,color:V.muted,letterSpacing:'0.06em'}}>{o?'HIDE SQL':'VIEW SQL'}</span>
      </div>
      {o && (
        <pre style={{marginTop:6,padding:'12px 14px',background:'#0b1220',color:'#cbd5e1',fontFamily:VM,fontSize:11,lineHeight:1.65,borderRadius:5,overflow:'auto',border:'1px solid #1e293b',whiteSpace:'pre'}}>
          {sql}
        </pre>
      )}
    </div>
  );
};

// ── Source citation chips ────────────────────────────────────────
const VSources = ({items}) => (
  <div style={{marginTop:8,display:'flex',gap:5,flexWrap:'wrap',alignItems:'center'}}>
    <span style={{fontSize:9,fontFamily:VM,fontWeight:700,letterSpacing:'0.1em',color:V.dim,textTransform:'uppercase',marginRight:2}}>Sources</span>
    {items.map(s=>(
      <span key={s} style={{display:'inline-flex',alignItems:'center',gap:4,fontSize:10,fontFamily:VM,fontWeight:600,color:V.muted,padding:'2px 7px',background:V.s2,border:`1px solid ${V.border}`,borderRadius:3}}>
        {VI('table',V.dim,9)}{s}
      </span>
    ))}
  </div>
);

// ── Data table ───────────────────────────────────────────────────
const VTable = ({cols,rows}) => (
  <div style={{marginTop:10,borderRadius:5,border:`1px solid ${V.border}`,overflow:'hidden',background:'#fff'}}>
    <table style={{width:'100%',borderCollapse:'collapse',fontSize:11,fontFamily:VM}}>
      <thead>
        <tr style={{background:V.s2}}>
          {cols.map(c=>(
            <th key={c} style={{padding:'7px 10px',textAlign:'left',fontSize:9,fontWeight:700,color:V.muted,letterSpacing:'0.06em',textTransform:'uppercase',borderBottom:`1px solid ${V.border}`,whiteSpace:'nowrap'}}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r,i)=>(
          <tr key={i} style={{borderBottom:i<rows.length-1?`1px solid ${V.border}`:'none',background:i%2===0?'#fff':V.surface}}>
            {cols.map(c=><td key={c} style={{padding:'6px 10px',color:V.text}}>{r[c]}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

// ── Stat card ────────────────────────────────────────────────────
const VStat = ({label,value,sub}) => (
  <div style={{marginTop:10,background:V.aD,border:'1px solid #bfdbfe',borderRadius:5,padding:'12px 14px'}}>
    <div style={{fontSize:9,fontFamily:VM,fontWeight:700,letterSpacing:'0.1em',color:V.accent,textTransform:'uppercase',marginBottom:4}}>{label}</div>
    <div style={{fontSize:22,fontWeight:700,letterSpacing:'-0.03em',color:V.text,lineHeight:1}}>{value}</div>
    <div style={{fontSize:10,color:V.muted,marginTop:4,fontFamily:VM}}>{sub}</div>
  </div>
);

// ── Action buttons ──────────────────────────────────────────────
const VActions = ({items}) => (
  <div style={{marginTop:10,display:'flex',gap:6,flexWrap:'wrap'}}>
    {items.map((a,i)=>(
      <button key={i} style={{display:'flex',alignItems:'center',gap:5,padding:'6px 11px',borderRadius:4,fontSize:11,fontWeight:600,fontFamily:VS,cursor:'pointer',border:a.primary?`1px solid ${V.accent}`:`1px solid ${V.border}`,background:a.primary?V.accent:'#fff',color:a.primary?'#fff':V.text,transition:'all 0.15s'}}>
        {a.icon && VI(a.icon,a.primary?'#fff':V.muted,11)}{a.label}
      </button>
    ))}
  </div>
);

// ── Bar chart ───────────────────────────────────────────────────
const VBar = ({data,title,unit=''}) => {
  const [view,setView] = useCv2S('bar');
  const max = Math.max(...data.map(d=>d.value));
  const fmt = v => unit==='$' ? '$' + (v>=1000?(v/1000).toFixed(1)+'k':v) : v;
  const W = 480, H = 160, pad = {l:10,r:10,t:8,b:24};
  const inner = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const bw = inner / data.length;
  return (
    <div style={{marginTop:10,padding:'12px 14px 10px',background:'#fff',border:`1px solid ${V.border}`,borderRadius:6}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
        <div style={{fontSize:9,fontFamily:VM,fontWeight:700,letterSpacing:'0.1em',color:V.muted,textTransform:'uppercase'}}>{title}</div>
        <div style={{display:'flex',gap:2,padding:2,background:V.surface,borderRadius:4,border:`1px solid ${V.border}`}}>
          {['bar','line','table'].map(t=>(
            <button key={t} onClick={()=>setView(t)} style={{padding:'2px 8px',borderRadius:3,fontSize:9,fontFamily:VM,fontWeight:700,letterSpacing:'0.06em',textTransform:'uppercase',background:view===t?'#fff':'transparent',color:view===t?V.accent:V.muted,border:view===t?`1px solid ${V.border}`:'1px solid transparent',cursor:'pointer',boxShadow:view===t?'0 1px 2px rgba(0,0,0,0.04)':'none'}}>{t}</button>
          ))}
        </div>
      </div>
      {view!=='table' && (
        <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:'auto',display:'block'}} preserveAspectRatio="none">
          {/* gridlines */}
          {[0.25,0.5,0.75,1].map(p=>(
            <line key={p} x1={pad.l} x2={W-pad.r} y1={pad.t+innerH*(1-p)} y2={pad.t+innerH*(1-p)} stroke={V.s2} strokeWidth={1}/>
          ))}
          {/* bar/line */}
          {view==='bar' && data.map((d,i)=>{
            const h = (d.value/max) * innerH;
            const x = pad.l + i*bw + bw*0.18;
            const y = pad.t + innerH - h;
            const w = bw * 0.64;
            return (
              <g key={i}>
                <rect x={x} y={y} width={w} height={h} fill={i===0?V.accent:'#93c5fd'} rx={1}/>
                <text x={x+w/2} y={H-9} textAnchor="middle" fontSize="8" fontFamily={VM} fill={V.muted}>{d.label}</text>
              </g>
            );
          })}
          {view==='line' && (
            <g>
              <polyline fill="none" stroke={V.accent} strokeWidth={2} points={data.map((d,i)=>{
                const x = pad.l + i*bw + bw/2;
                const y = pad.t + innerH - (d.value/max)*innerH;
                return `${x},${y}`;
              }).join(' ')}/>
              {data.map((d,i)=>{
                const x = pad.l + i*bw + bw/2;
                const y = pad.t + innerH - (d.value/max)*innerH;
                return (
                  <g key={i}>
                    <circle cx={x} cy={y} r={3} fill="#fff" stroke={V.accent} strokeWidth={2}/>
                    <text x={x} y={H-9} textAnchor="middle" fontSize="8" fontFamily={VM} fill={V.muted}>{d.label}</text>
                  </g>
                );
              })}
            </g>
          )}
        </svg>
      )}
      {view==='table' && (
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:11,fontFamily:VM,marginTop:2}}>
          <thead>
            <tr style={{background:V.s2}}>
              <th style={{padding:'5px 10px',textAlign:'left',fontSize:9,fontWeight:700,color:V.muted,letterSpacing:'0.06em',textTransform:'uppercase'}}>customer</th>
              <th style={{padding:'5px 10px',textAlign:'right',fontSize:9,fontWeight:700,color:V.muted,letterSpacing:'0.06em',textTransform:'uppercase'}}>revenue</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d,i)=>(
              <tr key={i} style={{borderBottom:i<data.length-1?`1px solid ${V.border}`:'none'}}>
                <td style={{padding:'5px 10px',color:V.text}}>{d.label}</td>
                <td style={{padding:'5px 10px',textAlign:'right',color:V.text}}>{fmt(d.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{marginTop:6,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <div style={{fontSize:9,fontFamily:VM,color:V.dim,letterSpacing:'0.04em'}}>{data.length} rows · max {fmt(max)}</div>
        <div style={{display:'flex',gap:6}}>
          <button style={{padding:'2px 8px',borderRadius:3,fontSize:9,fontFamily:VM,fontWeight:700,letterSpacing:'0.06em',textTransform:'uppercase',cursor:'pointer',border:`1px solid ${V.border}`,background:'#fff',color:V.muted}}>Save chart</button>
          <button style={{padding:'2px 8px',borderRadius:3,fontSize:9,fontFamily:VM,fontWeight:700,letterSpacing:'0.06em',textTransform:'uppercase',cursor:'pointer',border:`1px solid ${V.border}`,background:'#fff',color:V.muted}}>Export PNG</button>
        </div>
      </div>
    </div>
  );
};

// ── Plan card (multi-step execution plan) ───────────────────────
const VPlan = ({plan,onApprove,built}) => (
  <div style={{marginTop:10,background:'#fff',border:`1px solid ${V.border}`,borderRadius:6,overflow:'hidden'}}>
    <div style={{padding:'12px 14px',borderBottom:`1px solid ${V.border}`,background:'linear-gradient(180deg,#f7f9fc,#fff)',display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:10}}>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:9,fontFamily:VM,fontWeight:700,letterSpacing:'0.1em',color:V.accent,textTransform:'uppercase',marginBottom:3,display:'flex',alignItems:'center',gap:5}}>
          {VI('steps',V.accent,10)} Execution plan
        </div>
        <div style={{fontSize:13,fontWeight:700,color:V.text,letterSpacing:'-0.02em',lineHeight:1.3}}>{plan.title}</div>
      </div>
      <div style={{textAlign:'right',flexShrink:0}}>
        <div style={{fontSize:9,fontFamily:VM,fontWeight:700,letterSpacing:'0.06em',color:V.dim,textTransform:'uppercase'}}>Confidence</div>
        <div style={{fontSize:14,fontFamily:VM,fontWeight:700,color:V.green,letterSpacing:'-0.01em'}}>{Math.round(plan.confidence*100)}%</div>
      </div>
    </div>
    <div style={{padding:'4px 14px'}}>
      {plan.steps.map((s,i)=>{
        const meta = VND[s.type] || {};
        const ICO = VICO[s.type] || 'db';
        return (
          <div key={i} style={{display:'flex',gap:10,padding:'10px 0',borderBottom:i<plan.steps.length-1?`1px solid ${V.border}`:'none'}}>
            <div style={{display:'flex',flexDirection:'column',alignItems:'center',flexShrink:0,minWidth:24}}>
              <div style={{width:24,height:24,borderRadius:4,background:meta.color+'14',border:`1px solid ${meta.color}40`,display:'flex',alignItems:'center',justifyContent:'center'}}>
                {VI(ICO,meta.color,12)}
              </div>
              {i<plan.steps.length-1 && <div style={{width:1,flex:1,marginTop:4,background:V.border,minHeight:8}}/>}
            </div>
            <div style={{flex:1,minWidth:0,paddingTop:1}}>
              <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:3}}>
                <span style={{fontSize:9,fontFamily:VM,fontWeight:700,letterSpacing:'0.08em',color:meta.color,textTransform:'uppercase'}}>STEP {String(i+1).padStart(2,'0')} · {meta.label}</span>
              </div>
              <div style={{fontSize:12,fontWeight:600,color:V.text,marginBottom:2,letterSpacing:'-0.01em'}}>{s.title}</div>
              <div style={{fontSize:11,color:V.muted,lineHeight:1.55}}>{s.desc}</div>
            </div>
          </div>
        );
      })}
    </div>
    <div style={{padding:'10px 14px',borderTop:`1px solid ${V.border}`,background:V.surface,display:'flex',alignItems:'center',justifyContent:'space-between',gap:10}}>
      <div style={{fontSize:10,fontFamily:VM,color:V.muted,letterSpacing:'0.04em'}}>
        {plan.steps.length} steps · {plan.estimated}
      </div>
      <div style={{display:'flex',gap:6}}>
        <button style={{padding:'6px 11px',borderRadius:4,fontSize:11,fontWeight:600,fontFamily:VS,cursor:'pointer',border:`1px solid ${V.border}`,background:'#fff',color:V.muted}}>Edit plan</button>
        <button onClick={onApprove} disabled={built} style={{display:'flex',alignItems:'center',gap:5,padding:'6px 11px',borderRadius:4,fontSize:11,fontWeight:600,fontFamily:VS,cursor:built?'default':'pointer',border:`1px solid ${built?V.green:V.accent}`,background:built?'#f0fdf4':V.accent,color:built?V.green:'#fff'}}>
          {built ? <>{VI('check',V.green,11)} Workflow built</> : <>{VI('play','#fff',10)} Approve & build</>}
        </button>
      </div>
    </div>
  </div>
);

// ── Mini DAG (built workflow visualization) ─────────────────────
const VMiniDag = ({plan}) => {
  const W = 520, NW = 56, NH = 56, GAP = 18;
  const total = plan.steps.length;
  const innerW = total*NW + (total-1)*GAP;
  const startX = (W - innerW)/2;
  const cy = 36;
  return (
    <div style={{marginTop:10,padding:'12px 14px',background:'#fff',border:`1px solid ${V.border}`,borderRadius:6}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
        <div style={{display:'flex',alignItems:'center',gap:6}}>
          <span style={{width:6,height:6,borderRadius:'50%',background:V.green,boxShadow:`0 0 0 2px ${V.green}22`}}/>
          <span style={{fontSize:9,fontFamily:VM,fontWeight:700,letterSpacing:'0.1em',color:V.green,textTransform:'uppercase'}}>Workflow built · {total} nodes</span>
        </div>
        <button style={{display:'flex',alignItems:'center',gap:4,padding:'3px 9px',borderRadius:3,fontSize:9,fontFamily:VM,fontWeight:700,letterSpacing:'0.06em',textTransform:'uppercase',cursor:'pointer',border:`1px solid ${V.border}`,background:V.surface,color:V.muted}}>
          {VI('expand',V.muted,9)} Open canvas
        </button>
      </div>
      <svg viewBox={`0 0 ${W} 96`} style={{width:'100%',height:'auto',display:'block'}}>
        <defs>
          <marker id="vArr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={V.border2}/>
          </marker>
        </defs>
        {/* connectors */}
        {plan.steps.slice(0,-1).map((_,i)=>{
          const x1 = startX + i*(NW+GAP) + NW;
          const x2 = startX + (i+1)*(NW+GAP);
          return <line key={i} x1={x1} y1={cy} x2={x2-2} y2={cy} stroke={V.border2} strokeWidth={1.5} markerEnd="url(#vArr)"/>;
        })}
        {/* nodes */}
        {plan.steps.map((s,i)=>{
          const meta = VND[s.type] || {};
          const x = startX + i*(NW+GAP);
          return (
            <g key={i} transform={`translate(${x},${cy-NH/2})`}>
              <rect width={NW} height={NH} rx={5} fill="#fff" stroke={V.border} strokeWidth={1}/>
              <rect width={NW} height={5} rx={0} fill={meta.color}/>
              <rect x={(NW-22)/2} y={18} width={22} height={22} rx={4} fill={meta.color+'14'} stroke={meta.color+'40'} strokeWidth={1}/>
              <text x={NW/2} y={NH+12} textAnchor="middle" fontSize="8" fontFamily={VM} fontWeight={700} letterSpacing="0.06em" fill={V.muted}>{meta.label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
};

// ── Chat bubble ─────────────────────────────────────────────────
const VBubble = ({m,wide,onApprove}) => {
  const isUser = m.role === 'user';
  return (
    <div style={{display:'flex',gap:10,flexDirection:isUser?'row-reverse':'row',padding:`0 ${wide?'56px':'0px'}`}}>
      <div style={{width:26,height:26,borderRadius:4,flexShrink:0,background:isUser?V.aD:V.s2,border:`1px solid ${isUser?'#bfdbfe':V.border}`,display:'flex',alignItems:'center',justifyContent:'center',alignSelf:'flex-end'}}>
        {isUser?VI('user',V.accent,12):VI('bot',V.muted,12)}
      </div>
      <div style={{maxWidth:wide?'72%':'82%',minWidth:80}}>
        <div style={{padding:'10px 13px',borderRadius:6,background:isUser?V.accent:V.bg,border:isUser?'none':`1px solid ${V.border}`,color:isUser?'#fff':V.text,borderTopLeftRadius:!isUser?2:6,borderTopRightRadius:isUser?2:6,fontSize:12,lineHeight:1.65,wordBreak:'break-word',boxShadow:isUser?'none':'0 1px 3px rgba(0,0,0,0.04)'}}>
          <VBold text={m.text}/>
          {m.sources && <VSources items={m.sources}/>}
          {m.sql && <VSql sql={m.sql}/>}
          {m.table && <VTable cols={m.table.cols} rows={m.table.rows}/>}
          {m.chart?.type==='bar' && <VBar data={m.chart.data} title={m.chart.title} unit={m.chart.unit}/>}
          {m.stat && <VStat {...m.stat}/>}
          {m.actions && <VActions items={m.actions}/>}
          {m.plan && <VPlan plan={m.plan} onApprove={()=>onApprove?.(m)} built={m.built}/>}
          {m.built && m.plan && <VMiniDag plan={m.plan}/>}
        </div>
        <div style={{marginTop:4,fontSize:9,color:V.dim,fontFamily:VM,textAlign:isUser?'right':'left'}}>{m.ts}</div>
      </div>
    </div>
  );
};

// ── Typing indicator ────────────────────────────────────────────
const VTyping = () => (
  <div style={{display:'flex',gap:10,alignItems:'flex-end'}}>
    <div style={{width:26,height:26,borderRadius:4,background:V.s2,border:`1px solid ${V.border}`,display:'flex',alignItems:'center',justifyContent:'center'}}>
      {VI('bot',V.muted,12)}
    </div>
    <div style={{padding:'10px 14px',background:V.bg,border:`1px solid ${V.border}`,borderRadius:'6px 6px 6px 2px',display:'flex',alignItems:'center',gap:5}}>
      {[0,1,2].map(n=><div key={n} style={{width:5,height:5,borderRadius:'50%',background:V.dim,animation:'dgblink 1.4s ease infinite',animationDelay:`${n*0.2}s`}}/>)}
    </div>
  </div>
);

// ── Suggested-action grid (empty state) ────────────────────────
const V_SUGS = [
  { icon:'table',  title:'Query my data',     sub:'Ask in plain English' },
  { icon:'steps',  title:'Plan a pipeline',   sub:'Multi-step execution' },
  { icon:'bar',    title:'Visualise results', sub:'Charts & exports' },
  { icon:'zap',    title:'Edit a workflow',   sub:'Modify the canvas' },
];
const VSugGrid = ({onPick}) => (
  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,maxWidth:480,width:'100%',margin:'0 auto'}}>
    {V_SUGS.map(s=>{
      const [hov,sH] = useCv2S(false);
      return (
        <div key={s.title} onClick={()=>onPick?.(s.title)} onMouseEnter={()=>sH(true)} onMouseLeave={()=>sH(false)}
          style={{padding:'12px 14px',borderRadius:6,border:`1px solid ${hov?'#bfdbfe':V.border}`,background:hov?V.aD:'#fff',cursor:'pointer',transition:'all 0.15s'}}>
          <div style={{width:24,height:24,borderRadius:4,background:V.aD,border:'1px solid #bfdbfe',display:'flex',alignItems:'center',justifyContent:'center',marginBottom:8}}>
            {VI(s.icon,V.accent,12)}
          </div>
          <div style={{fontSize:12,fontWeight:600,color:V.text,marginBottom:2,letterSpacing:'-0.01em'}}>{s.title}</div>
          <div style={{fontSize:10,color:V.muted,fontFamily:VM}}>{s.sub}</div>
        </div>
      );
    })}
  </div>
);

// ── History sidebar ─────────────────────────────────────────────
const VHistory = ({convos,activeId,onSelect,onNew}) => {
  const [q,sQ] = useCv2S('');
  const filtered = useCv2M(()=>{
    const ql = q.trim().toLowerCase();
    return ql ? convos.filter(c=>c.title.toLowerCase().includes(ql)||c.preview.toLowerCase().includes(ql)) : convos;
  },[q,convos]);
  const groups = useCv2M(()=>{
    const order=['Today','Yesterday','Last 7 days','Older'];
    const map={};
    filtered.forEach(c=>{(map[c.group]=map[c.group]||[]).push(c);});
    return order.filter(g=>map[g]).map(g=>[g,map[g]]);
  },[filtered]);
  return (
    <div style={{width:280,borderRight:`1px solid ${V.border}`,background:V.bg,display:'flex',flexDirection:'column',flexShrink:0}}>
      <div style={{padding:'14px 14px 10px',borderBottom:`1px solid ${V.border}`}}>
        <button onClick={onNew} style={{display:'flex',alignItems:'center',justifyContent:'center',gap:6,width:'100%',padding:'8px 10px',borderRadius:5,background:V.accent,border:`1px solid ${V.accent}`,cursor:'pointer',fontSize:12,fontWeight:600,color:'#fff',fontFamily:VS,marginBottom:10}}>
          {VI('plus','#fff',12)} New chat
        </button>
        <div style={{position:'relative'}}>
          <div style={{position:'absolute',left:9,top:'50%',transform:'translateY(-50%)',pointerEvents:'none',display:'flex'}}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={V.dim} strokeWidth="2"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/></svg>
          </div>
          <input value={q} onChange={e=>sQ(e.target.value)} placeholder="Search history…"
            style={{width:'100%',padding:'7px 10px 7px 28px',border:`1px solid ${V.border}`,borderRadius:4,fontSize:11,fontFamily:VS,color:V.text,background:V.surface,outline:'none'}}/>
          {q && (
            <button onClick={()=>sQ('')} style={{position:'absolute',right:6,top:'50%',transform:'translateY(-50%)',border:'none',background:'transparent',cursor:'pointer',padding:2,color:V.dim}}>
              {VI('close',V.dim,12)}
            </button>
          )}
        </div>
      </div>
      <div style={{flex:1,overflowY:'auto',padding:'8px 6px'}}>
        {groups.map(([g,items])=>(
          <div key={g} style={{marginBottom:10}}>
            <div style={{padding:'4px 8px 6px',fontSize:9,fontFamily:VM,fontWeight:700,letterSpacing:'0.1em',color:V.dim,textTransform:'uppercase',display:'flex',alignItems:'center',gap:6}}>
              <span>{g}</span>
              <div style={{flex:1,height:1,background:V.border}}/>
              <span>{items.length}</span>
            </div>
            {items.map(c=>(
              <div key={c.id} onClick={()=>onSelect(c.id)}
                style={{padding:'9px 10px',borderRadius:5,cursor:'pointer',marginBottom:1,background:c.id===activeId?V.aD:'transparent',border:`1px solid ${c.id===activeId?'#bfdbfe':'transparent'}`,transition:'all 0.12s'}}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:3,gap:6}}>
                  <div style={{fontSize:11,fontWeight:600,color:V.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flex:1,letterSpacing:'-0.01em'}}>{c.title}</div>
                  {c.status==='plan' && <span style={{fontSize:8,fontFamily:VM,fontWeight:700,letterSpacing:'0.06em',color:'#6d28d9',background:'#f3e8ff',padding:'1px 5px',borderRadius:3,border:'1px solid #ddd6fe',flexShrink:0}}>PLAN</span>}
                  {c.status==='completed' && <span style={{fontSize:8,fontFamily:VM,fontWeight:700,letterSpacing:'0.06em',color:V.green,background:'#dcfce7',padding:'1px 5px',borderRadius:3,border:'1px solid #bbf7d0',flexShrink:0}}>DONE</span>}
                </div>
                <div style={{fontSize:10,color:V.muted,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginBottom:3}}>{c.preview}</div>
                <div style={{fontSize:9,fontFamily:VM,color:V.dim,letterSpacing:'0.04em'}}>{c.date}</div>
              </div>
            ))}
          </div>
        ))}
        {groups.length===0 && (
          <div style={{padding:'30px 14px',textAlign:'center',fontSize:11,color:V.muted}}>
            <div style={{marginBottom:6}}>No matches for</div>
            <div style={{fontFamily:VM,color:V.text,fontWeight:600}}>"{q}"</div>
          </div>
        )}
      </div>
      <div style={{padding:'10px 14px',borderTop:`1px solid ${V.border}`,fontSize:9,fontFamily:VM,color:V.dim,letterSpacing:'0.06em',textTransform:'uppercase',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <span>{convos.length} conversations</span>
        <span style={{display:'flex',alignItems:'center',gap:4}}><span style={{width:5,height:5,borderRadius:'50%',background:V.green}}/>synced</span>
      </div>
    </div>
  );
};

// ── Right rail (Export Report) ─────────────────────────────────
const VRail = ({mode,onClose,msgs,title}) => {
  if (mode!=='report') return null;
  const stats = {
    msgs: msgs.length,
    sql:   msgs.filter(m=>m.sql).length,
    tables:msgs.filter(m=>m.table).length,
    charts:msgs.filter(m=>m.chart).length,
    plans: msgs.filter(m=>m.plan).length,
  };
  const fmts = [
    {label:'PDF',  sub:'Print-ready',  k:'pdf'},
    {label:'CSV',  sub:'Tables only',  k:'csv'},
    {label:'PNG',  sub:'Charts only',  k:'png'},
    {label:'JSON', sub:'Workflow',     k:'json'},
  ];
  const [fmt,sFmt] = useCv2S('pdf');
  return (
    <div style={{width:340,borderLeft:`1px solid ${V.border}`,background:V.bg,display:'flex',flexDirection:'column',flexShrink:0}}>
      <div style={{padding:'12px 16px',borderBottom:`1px solid ${V.border}`,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div>
          <div style={{fontSize:9,fontFamily:VM,fontWeight:700,letterSpacing:'0.1em',color:V.muted,textTransform:'uppercase',marginBottom:1}}>Export</div>
          <div style={{fontSize:14,fontWeight:700,color:V.text,letterSpacing:'-0.02em'}}>Build report</div>
        </div>
        <button onClick={onClose} style={{border:'none',background:'none',cursor:'pointer',color:V.muted,padding:5,borderRadius:3}}>
          {VI('close',V.muted,14)}
        </button>
      </div>
      <div style={{flex:1,overflowY:'auto',padding:'14px 16px'}}>
        <div style={{fontSize:9,fontFamily:VM,fontWeight:700,letterSpacing:'0.1em',color:V.dim,textTransform:'uppercase',marginBottom:6}}>Title</div>
        <input defaultValue={title} style={{width:'100%',padding:'8px 10px',border:`1px solid ${V.border}`,borderRadius:4,fontSize:12,color:V.text,outline:'none',marginBottom:14,fontFamily:VS}}/>

        <div style={{fontSize:9,fontFamily:VM,fontWeight:700,letterSpacing:'0.1em',color:V.dim,textTransform:'uppercase',marginBottom:6}}>Include</div>
        {[
          {label:'Conversation transcript', count:`${stats.msgs} messages`,  on:true},
          {label:'SQL queries',             count:`${stats.sql} queries`,   on:true},
          {label:'Data tables',             count:`${stats.tables} tables`, on:true},
          {label:'Charts',                  count:`${stats.charts} charts`, on:true},
          {label:'Execution plans',         count:`${stats.plans} plans`,   on:stats.plans>0},
          {label:'Source citations',        count:'inline',                 on:false},
        ].map((opt,i)=>(
          <label key={i} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'8px 11px',borderRadius:4,border:`1px solid ${V.border}`,marginBottom:5,cursor:'pointer',background:'#fff'}}>
            <div style={{display:'flex',alignItems:'center',gap:9}}>
              <input type="checkbox" defaultChecked={opt.on} style={{accentColor:V.accent,width:14,height:14}}/>
              <span style={{fontSize:12,color:V.text}}>{opt.label}</span>
            </div>
            <span style={{fontSize:9,fontFamily:VM,color:V.dim,letterSpacing:'0.04em'}}>{opt.count}</span>
          </label>
        ))}

        <div style={{marginTop:18,fontSize:9,fontFamily:VM,fontWeight:700,letterSpacing:'0.1em',color:V.dim,textTransform:'uppercase',marginBottom:6}}>Format</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,marginBottom:14}}>
          {fmts.map(f=>(
            <div key={f.k} onClick={()=>sFmt(f.k)} style={{padding:'10px 11px',borderRadius:4,border:`1px solid ${fmt===f.k?V.accent:V.border}`,background:fmt===f.k?V.aD:'#fff',cursor:'pointer',transition:'all 0.15s'}}>
              <div style={{fontSize:11,fontWeight:700,color:fmt===f.k?V.accent:V.text,letterSpacing:'-0.01em'}}>{f.label}</div>
              <div style={{fontSize:9,fontFamily:VM,color:V.muted,marginTop:1}}>{f.sub}</div>
            </div>
          ))}
        </div>

        <div style={{marginTop:6,fontSize:9,fontFamily:VM,fontWeight:700,letterSpacing:'0.1em',color:V.dim,textTransform:'uppercase',marginBottom:6}}>Delivery</div>
        <div style={{padding:'10px 12px',borderRadius:4,border:`1px solid ${V.border}`,background:'#fff',marginBottom:6}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <input type="radio" name="del" defaultChecked style={{accentColor:V.accent}}/>
              <span style={{fontSize:12,color:V.text}}>Download</span>
            </div>
            <span style={{fontSize:9,fontFamily:VM,color:V.dim}}>now</span>
          </div>
        </div>
        <div style={{padding:'10px 12px',borderRadius:4,border:`1px solid ${V.border}`,background:'#fff',marginBottom:14}}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <input type="radio" name="del" style={{accentColor:V.accent}}/>
              <span style={{fontSize:12,color:V.text}}>Email + schedule</span>
            </div>
            <span style={{fontSize:9,fontFamily:VM,color:V.dim}}>daily 06:00</span>
          </div>
        </div>

        <div style={{padding:'10px 12px',borderRadius:4,background:V.surface,border:`1px solid ${V.border}`,display:'flex',alignItems:'center',gap:8}}>
          <div style={{width:6,height:6,borderRadius:'50%',background:V.green}}/>
          <div style={{flex:1,fontSize:10,color:V.muted,fontFamily:VM,letterSpacing:'0.04em'}}>2 pages · est. 144 KB</div>
        </div>
      </div>
      <div style={{padding:'12px 16px',borderTop:`1px solid ${V.border}`,display:'flex',gap:6}}>
        <button style={{flex:1,padding:'8px 10px',borderRadius:4,border:`1px solid ${V.border}`,background:'#fff',cursor:'pointer',fontSize:11,fontWeight:600,color:V.muted,fontFamily:VS}}>Preview</button>
        <button style={{flex:1.4,display:'flex',alignItems:'center',justifyContent:'center',gap:5,padding:'8px 10px',borderRadius:4,border:`1px solid ${V.accent}`,background:V.accent,cursor:'pointer',fontSize:11,fontWeight:600,color:'#fff',fontFamily:VS}}>
          {VI('save','#fff',11)} Export {fmt.toUpperCase()}
        </button>
      </div>
    </div>
  );
};

// ── Chat header ─────────────────────────────────────────────────
const VHeader = ({title,wide,onExpand,onClose,onMin,onReport,onRail}) => (
  <div style={{padding:'10px 14px',borderBottom:`1px solid ${V.border}`,background:V.bg,display:'flex',alignItems:'center',gap:10,flexShrink:0}}>
    <div style={{width:28,height:28,borderRadius:5,background:V.aD,border:'1px solid #bfdbfe',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
      {VI('bot',V.accent,14)}
    </div>
    <div style={{flex:1,minWidth:0}}>
      <div style={{fontSize:13,fontWeight:600,color:V.text,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',letterSpacing:'-0.01em'}}>{title}</div>
      <div style={{fontSize:9,fontFamily:VM,color:V.muted,letterSpacing:'0.08em',textTransform:'uppercase',display:'flex',alignItems:'center',gap:5,marginTop:1}}>
        <span style={{width:5,height:5,borderRadius:'50%',background:V.green,boxShadow:`0 0 0 2px ${V.green}22`,display:'inline-block'}}/>
        Dagflux Assistant · ready
      </div>
    </div>
    <div style={{display:'flex',alignItems:'center',gap:5}}>
      {wide && (
        <button onClick={onRail} title="Export report" style={{display:'flex',alignItems:'center',gap:5,padding:'5px 10px',borderRadius:4,background:V.surface,border:`1px solid ${V.border}`,cursor:'pointer',fontSize:11,fontWeight:500,color:V.muted,fontFamily:VS}}>
          {VI('report',V.muted,12)} Export Report
        </button>
      )}
      <button onClick={onExpand} title={wide?'Collapse to popup':'Expand'} style={{padding:6,borderRadius:4,background:'transparent',border:'none',cursor:'pointer',color:V.muted,display:'flex'}}>
        {VI(wide?'close':'expand',V.muted,14)}
      </button>
      {!wide && (
        <button onClick={onClose} title="Close" style={{padding:6,borderRadius:4,background:'transparent',border:'none',cursor:'pointer',color:V.muted,display:'flex'}}>
          {VI('close',V.muted,14)}
        </button>
      )}
    </div>
  </div>
);

// ── Composer ────────────────────────────────────────────────────
const VComposer = ({input,setInput,onSend,wide,suggestions}) => (
  <div style={{padding:wide?'14px 56px 18px':'12px 14px',borderTop:`1px solid ${V.border}`,background:V.bg,flexShrink:0}}>
    {suggestions && (
      <div style={{maxWidth:wide?720:'100%',margin:'0 auto 8px',display:'flex',gap:6,flexWrap:'wrap'}}>
        {suggestions.map(s=>(
          <button key={s} onClick={()=>setInput(s)}
            style={{padding:'4px 10px',borderRadius:20,background:V.surface,border:`1px solid ${V.border}`,cursor:'pointer',fontSize:11,color:V.muted,fontFamily:VS}}>{s}</button>
        ))}
      </div>
    )}
    <div style={{maxWidth:wide?720:'100%',margin:'0 auto',display:'flex',gap:8,alignItems:'flex-end'}}>
      <div style={{flex:1,position:'relative',background:V.bg,border:`1px solid ${V.border}`,borderRadius:6,transition:'border-color 0.15s'}}>
        <textarea value={input} onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();onSend();}}}
          placeholder="Ask about workflows, connections, or your data…" rows={2}
          style={{width:'100%',border:'none',padding:'10px 12px 32px',fontSize:12,fontFamily:VS,color:V.text,resize:'none',outline:'none',lineHeight:1.6,background:'transparent',display:'block'}}/>
        <div style={{position:'absolute',left:10,bottom:8,right:10,display:'flex',gap:4,alignItems:'center',justifyContent:'space-between',pointerEvents:'none'}}>
          <div style={{display:'flex',gap:4}}>
            <span style={{fontSize:9,fontFamily:VM,color:V.muted,letterSpacing:'0.06em',textTransform:'uppercase',padding:'2px 6px',borderRadius:3,background:V.surface,border:`1px solid ${V.border}`,fontWeight:600}}>@workflow</span>
            <span style={{fontSize:9,fontFamily:VM,color:V.dim,letterSpacing:'0.06em',textTransform:'uppercase',padding:'2px 6px',borderRadius:3,background:V.surface,border:`1px solid ${V.border}`}}>/plan</span>
          </div>
          <span style={{fontSize:9,fontFamily:VM,color:V.dim,letterSpacing:'0.06em',textTransform:'uppercase'}}>↵ send · ⇧↵ newline</span>
        </div>
      </div>
      <button onClick={onSend} style={{width:38,height:38,borderRadius:5,background:input.trim()?V.accent:V.s2,border:'none',cursor:input.trim()?'pointer':'default',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,transition:'background 0.15s'}}>
        {VI('send',input.trim()?'#fff':V.dim,14)}
      </button>
    </div>
  </div>
);

// ── Orchestrator ────────────────────────────────────────────────
const VAssistant = () => {
  const [open,sOpen] = useCv2S(true);    // start with popup open so design is visible
  const [wide,sWide] = useCv2S(false);
  const [activeId,sActive] = useCv2S('c1');
  const [chats,sChats] = useCv2S(V_CHATS);
  const [convos,sConvos] = useCv2S(V_CONVOS);
  const [input,sInput] = useCv2S('');
  const [typing,sTyping] = useCv2S(false);
  const [rail,sRail] = useCv2S(null);    // null | 'report'
  const endRef = useCv2R(null);

  const active = convos.find(c=>c.id===activeId);
  const msgs = chats[activeId] || [];

  useCv2E(()=>{ if(endRef.current){ endRef.current.scrollTop = endRef.current.scrollHeight; } },[msgs.length,typing,activeId]);

  const send = () => {
    if (!input.trim()) return;
    const ts = new Date().toLocaleTimeString('en',{hour:'numeric',minute:'2-digit'});
    const userMsg = {role:'user',text:input,ts};
    sChats(p=>({...p,[activeId]:[...(p[activeId]||[]),userMsg]}));
    sInput('');
    sTyping(true);
    setTimeout(()=>{
      sChats(p=>({...p,[activeId]:[...(p[activeId]||[]),{role:'bot',text:"Got it — I'm querying your pipeline now. Results will stream in shortly.",ts}]}));
      sTyping(false);
    },1100);
  };

  const newChat = () => {
    const id = 'c'+Date.now();
    sConvos(p=>[{id,title:'New chat',preview:'Start a new conversation',date:'Just now',group:'Today'},...p]);
    sChats(p=>({...p,[id]:[]}));
    sActive(id);
    sInput('');
  };

  const approve = (msg) => {
    sChats(p=>({...p,[activeId]:p[activeId].map(m=>m===msg?{...m,built:true}:m)}));
    // append a follow-up after a beat
    setTimeout(()=>{
      sChats(p=>({...p,[activeId]:[...(p[activeId]||[]),{role:'bot',text:"Workflow built on the canvas. I've also scheduled the daily export at **06:00 UTC**. You can run it now or open the canvas to inspect each node.",ts:new Date().toLocaleTimeString('en',{hour:'numeric',minute:'2-digit'})}]}));
    },700);
  };

  if (!open) {
    return (
      <button onClick={()=>sOpen(true)} title="Open Dagflux Assistant"
        style={{position:'fixed',bottom:24,right:24,height:48,padding:'0 16px 0 14px',borderRadius:24,background:V.accent,border:'none',boxShadow:'0 12px 32px rgba(37,99,235,0.32), 0 4px 12px rgba(0,0,0,0.08)',cursor:'pointer',zIndex:1000,display:'flex',alignItems:'center',gap:8,transition:'all 0.2s'}}>
        {VI('bot','#fff',18)}
        <span style={{fontSize:13,fontWeight:600,color:'#fff',fontFamily:VS,letterSpacing:'-0.01em'}}>Ask Dagflux</span>
      </button>
    );
  }

  // ── Popup mode ────────────────────────────────────────────────
  if (!wide) {
    return (
      <div style={{position:'fixed',bottom:24,right:24,width:460,height:640,borderRadius:10,background:'#fff',boxShadow:'0 24px 64px rgba(0,0,0,0.2), 0 4px 16px rgba(0,0,0,0.06)',border:`1px solid ${V.border}`,display:'flex',flexDirection:'column',overflow:'hidden',zIndex:1000,fontFamily:VS}}>
        <VHeader title={active?.title||'New chat'} wide={false} onExpand={()=>sWide(true)} onClose={()=>sOpen(false)}/>
        <div ref={endRef} style={{flex:1,overflowY:'auto',padding:'14px',display:'flex',flexDirection:'column',gap:14,background:V.surface}}>
          {msgs.length===0 ? (
            <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:14,padding:'12px 4px'}}>
              <div style={{width:44,height:44,borderRadius:8,background:V.aD,border:'1px solid #bfdbfe',display:'flex',alignItems:'center',justifyContent:'center'}}>
                {VI('bot',V.accent,22)}
              </div>
              <div style={{textAlign:'center'}}>
                <div style={{fontSize:14,fontWeight:700,color:V.text,letterSpacing:'-0.02em',marginBottom:3}}>How can I help?</div>
                <div style={{fontSize:11,color:V.muted}}>Ask about workflows, edits, or your data.</div>
              </div>
              <VSugGrid onPick={sInput}/>
            </div>
          ) : msgs.map((m,i)=><VBubble key={i} m={m} wide={false} onApprove={approve}/>)}
          {typing && <VTyping/>}
        </div>
        <VComposer input={input} setInput={sInput} onSend={send} wide={false}
          suggestions={msgs.length>0?['Visualise as bar chart','Plan a pipeline','Export to CSV']:null}/>
      </div>
    );
  }

  // ── Expanded mode ─────────────────────────────────────────────
  return (
    <div onClick={(e)=>{if(e.target===e.currentTarget)sWide(false);}}
      style={{position:'fixed',inset:0,background:'rgba(15,23,42,0.42)',backdropFilter:'blur(3px)',zIndex:1000,padding:24,display:'flex',fontFamily:VS}}>
      <div style={{flex:1,background:'#fff',borderRadius:12,boxShadow:'0 32px 80px rgba(0,0,0,0.32)',display:'flex',overflow:'hidden',border:`1px solid ${V.border}`}}>
        <VHistory convos={convos} activeId={activeId} onSelect={sActive} onNew={newChat}/>
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minWidth:0}}>
          <VHeader title={active?.title||'New chat'} wide={true} onExpand={()=>sWide(false)} onClose={()=>sOpen(false)}
            onRail={()=>sRail(rail==='report'?null:'report')}/>
          <div ref={endRef} style={{flex:1,overflowY:'auto',padding:'24px 0',display:'flex',flexDirection:'column',gap:18,background:V.surface}}>
            {msgs.length===0 ? (
              <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:18,padding:24}}>
                <div style={{width:60,height:60,borderRadius:10,background:V.aD,border:'1px solid #bfdbfe',display:'flex',alignItems:'center',justifyContent:'center'}}>
                  {VI('bot',V.accent,28)}
                </div>
                <div style={{textAlign:'center'}}>
                  <div style={{fontSize:20,fontWeight:700,color:V.text,letterSpacing:'-0.03em',marginBottom:5}}>Dagflux Assistant</div>
                  <div style={{fontSize:12,color:V.muted}}>Ask about your workflows, connections, data, or have me build a pipeline for you.</div>
                </div>
                <VSugGrid onPick={sInput}/>
              </div>
            ) : msgs.map((m,i)=><VBubble key={i} m={m} wide={true} onApprove={approve}/>)}
            {typing && <div style={{padding:'0 56px'}}><VTyping/></div>}
          </div>
          <VComposer input={input} setInput={sInput} onSend={send} wide={true}
            suggestions={msgs.length>0?['Visualise as bar chart','Plan a pipeline','Export this chat as PDF','Edit on canvas']:null}/>
        </div>
        <VRail mode={rail} onClose={()=>sRail(null)} msgs={msgs} title={active?.title}/>
      </div>
    </div>
  );
};

// ── Mount ───────────────────────────────────────────────────────
const __vChatRoot = ReactDOM.createRoot(document.getElementById('chat-root'));
__vChatRoot.render(<VAssistant/>);
