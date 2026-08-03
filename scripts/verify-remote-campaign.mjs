import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
const apiUrl = (process.env.AXIOM_LOCAL_API_URL || "http://127.0.0.1:4174").replace(/\/+$/, "");
if (!supabaseUrl || !serviceRoleKey || !publishableKey) throw new Error("Campaign verification requires Supabase URL, service role key, and publishable key.");

const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
const credentials = { email: `axiom.campaign.e2e+${Date.now()}-${randomBytes(4).toString("hex")}@example.com`, password: `Ax!${randomBytes(24).toString("base64url")}9z` };
let userId; let workspaceId;

async function api(path, token, method="GET", body=null) {
  const response = await fetch(`${apiUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body?{"content-type":"application/json"}:{}) }, body: body?JSON.stringify(body):null });
  const payload = await response.json().catch(()=>null);
  assert.ok(response.ok, `${method} ${path} failed: ${JSON.stringify(payload)}`);
  return payload;
}

try {
  const { data: created, error: createError } = await admin.auth.admin.createUser({ ...credentials, email_confirm: true });
  if(createError||!created.user)throw createError??new Error("User creation failed"); userId=created.user.id;
  const client=createClient(supabaseUrl,publishableKey,{auth:{autoRefreshToken:false,persistSession:false}});
  const {data:signedIn,error:signInError}=await client.auth.signInWithPassword(credentials);
  if(signInError||!signedIn.session)throw signInError??new Error("Sign-in failed"); const token=signedIn.session.access_token;
  const {data:workspace,error:workspaceError}=await admin.from("workspaces").select("id").eq("created_by",userId).single();
  if(workspaceError)throw workspaceError; workspaceId=workspace.id;
  const {data:run,error:runError}=await admin.from("runs").insert({workspace_id:workspaceId,created_by:userId,schema_version:"2.0.0",status:"evidence_ready",target_id:"CHEMBL_TEST",target_label:"Local campaign verification",disease_id:"EFO_TEST",disease_label:"verification"}).select("id").single();
  if(runError)throw runError;
  const campaign=await api(`/api/runs/${run.id}/campaigns`,token,"POST",{name:"Local queue verification",objective:"Verify durable asynchronous campaign execution",settings:{receptorId:"verification",center:{x:0,y:0,z:0},size:{x:22,y:22,z:22},exhaustiveness:8}});
  const candidate=await api(`/api/campaigns/${campaign.id}/candidates`,token,"POST",{name:"Aspirin",smiles:"CC(=O)Oc1ccccc1C(=O)O"});
  const queued=await api(`/api/candidates/${candidate.id}/queue`,token,"POST",{});
  assert.equal(queued.jobs.length,6);
  let snapshot;
  for(let attempt=0;attempt<180;attempt+=1){
    snapshot=(await api(`/api/runs/${run.id}/campaigns`,token)).items[0];
    const statuses=snapshot.candidates[0].jobs.map(job=>job.status);
    if(statuses.length===6&&statuses.every(status=>["succeeded","blocked","failed","cancelled"].includes(status)))break;
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  const completed=snapshot.candidates[0];
  assert.equal(completed.jobs.length,6);
  assert.ok(completed.jobs.every(job=>["succeeded","blocked"].includes(job.status)),JSON.stringify(completed.jobs.map(job=>[job.job_type,job.status,job.error])));
  assert.ok(completed.evaluations.some(item=>item.evaluation_type==="molecule_prep"&&item.status==="completed"));
  assert.ok(completed.evaluations.some(item=>item.evaluation_type==="admet"&&item.status==="completed"));
  assert.ok(completed.evaluations.some(item=>item.evaluation_type==="docking_score"&&item.status==="blocked"));
  assert.ok(Number.isFinite(completed.rank_score));
  await api(`/api/candidates/${candidate.id}/reviews`,token,"POST",{decision:"hold",rationale:"Automated verification requires human follow-up."});
  snapshot=(await api(`/api/runs/${run.id}/campaigns`,token)).items[0];
  assert.equal(snapshot.candidates[0].status,"held");
  assert.equal(snapshot.candidates[0].reviews.length,1);
  console.log(JSON.stringify({ok:true,jobs:completed.jobs.map(job=>({type:job.job_type,status:job.status})),rankScore:completed.rank_score,review:snapshot.candidates[0].reviews[0].decision},null,2));
} finally {
  if(workspaceId)await admin.from("workspaces").delete().eq("id",workspaceId);
  if(userId)await admin.auth.admin.deleteUser(userId);
}
