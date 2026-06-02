import { useState, useEffect, useRef } from "react";
import {
  collection, doc, onSnapshot, setDoc, deleteDoc,
  updateDoc, addDoc, serverTimestamp, query, orderBy
} from "firebase/firestore";
import {
  ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from "firebase/storage";
import { db, storage } from "./firebase";

// ─── Constants ────────────────────────────────────────────────────────────────
const STAGES = [
  { id: "intake",    label: "Intake",        color: "#6B7280", accent: "#9CA3AF" },
  { id: "inspect",  label: "Inspection",     color: "#D97706", accent: "#FCD34D" },
  { id: "parts",    label: "Parts Ordered",  color: "#7C3AED", accent: "#C4B5FD" },
  { id: "service",  label: "In Service",     color: "#2563EB", accent: "#93C5FD" },
  { id: "detail",   label: "Detail",         color: "#059669", accent: "#6EE7B7" },
  { id: "photos",   label: "Photos",         color: "#DB2777", accent: "#F9A8D4" },
  { id: "frontline",label: "Front Line ✓",   color: "#16A34A", accent: "#86EFAC" },
];
const STAGE_IDS = STAGES.map(s => s.id);
const ROLES = { admin: "Admin", manager: "Manager", tech: "Technician", viewer: "Viewer" };
const VENDOR_TYPES = ["Body Shop", "Detail", "Mechanical", "Glass", "Upholstery", "Tires", "PDR", "Other"];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function uid()   { return Math.random().toString(36).slice(2, 10); }
function fmt$(n) { const v = parseFloat(n); return isNaN(v) ? "$0.00" : "$" + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,","); }
function daysAgo(ts) {
  if (!ts) return "—";
  const ms = ts.toMillis ? ts.toMillis() : ts;
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d === 0 ? "today" : d === 1 ? "1 day" : `${d} days`;
}
function initials(name) { return name ? name.split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2) : "?"; }
function avatarColor(name) {
  const colors = ["#7C3AED","#2563EB","#059669","#D97706","#DB2777","#DC2626","#0891B2"];
  let h = 0; for (let c of (name||"")) h = (h*31 + c.charCodeAt(0)) % colors.length;
  return colors[h];
}

// ─── Firestore collection refs ────────────────────────────────────────────────
const col = (name) => collection(db, name);

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function ReconTracker() {
  // Data state — all synced from Firestore in real time
  const [vehicles,   setVehicles]   = useState([]);
  const [parts,      setParts]      = useState([]);
  const [notes,      setNotes]      = useState([]);
  const [photos,     setPhotos]     = useState([]);
  const [users,      setUsers]      = useState([]);
  const [vendors,    setVendors]    = useState([]);
  const [vendorJobs, setVendorJobs] = useState([]);
  const [loaded,     setLoaded]     = useState(false);

  // Auth
  const [currentUser, setCurrentUser] = useState(null);
  const [loginName,   setLoginName]   = useState("");
  const [loginPin,    setLoginPin]    = useState("");
  const [loginError,  setLoginError]  = useState("");

  // UI
  const [view,             setView]             = useState("board");
  const [detailVehicleId,  setDetailVehicleId]  = useState(null);
  const [detailTab,        setDetailTab]        = useState("info");
  const [addingVehicle,    setAddingVehicle]    = useState(false);
  const [newV,             setNewV]             = useState(blankVehicle());
  const [noteInput,        setNoteInput]        = useState("");
  const [newPart,          setNewPart]          = useState({ name:"", cost:"", status:"ordered", vendorId:"" });
  const [stageFilter,      setStageFilter]      = useState(null);
  const [searchQ,          setSearchQ]          = useState("");
  const [confirmDelete,    setConfirmDelete]    = useState(null);
  const [photoCaption,     setPhotoCaption]     = useState("");
  const [uploading,        setUploading]        = useState(false);
  const [lightbox,         setLightbox]         = useState(null);
  const [addingUser,       setAddingUser]       = useState(false);
  const [newUser,          setNewUser]          = useState({ name:"", pin:"", role:"tech" });
  const [addingVendor,     setAddingVendor]     = useState(false);
  const [newVendor,        setNewVendor]        = useState({ name:"", type:"Mechanical", phone:"", contact:"", notes:"" });
  const [vendorDetail,     setVendorDetail]     = useState(null);
  const [addingJob,        setAddingJob]        = useState(false);
  const [newJob,           setNewJob]           = useState({ vendorId:"", description:"", cost:"", status:"pending" });
  const fileInputRef = useRef();

  // ── Real-time Firestore listeners ──
  // Users load first so login screen appears immediately — rest loads in background
  useEffect(() => {
    const unsubs = [
      onSnapshot(col("users"),      s => { setUsers(s.docs.map(d=>({id:d.id,...d.data()}))); setLoaded(true); }),
      onSnapshot(col("vehicles"),   s => { setVehicles(s.docs.map(d=>({id:d.id,...d.data()}))); }),
      onSnapshot(col("parts"),      s => { setParts(s.docs.map(d=>({id:d.id,...d.data()}))); }),
      onSnapshot(col("notes"),      s => { setNotes(s.docs.map(d=>({id:d.id,...d.data()}))); }),
      onSnapshot(col("photos"),     s => { setPhotos(s.docs.map(d=>({id:d.id,...d.data()}))); }),
      onSnapshot(col("vendors"),    s => { setVendors(s.docs.map(d=>({id:d.id,...d.data()}))); }),
      onSnapshot(col("vendorJobs"), s => { setVendorJobs(s.docs.map(d=>({id:d.id,...d.data()}))); }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  // Seed admin user if users collection is empty on first load
  useEffect(() => {
    if (loaded && users.length === 0) {
      setDoc(doc(db, "users", "u_admin"), {
        name: "Admin", pin: "1234", role: "admin", createdAt: serverTimestamp()
      });
    }
  }, [loaded, users.length]);

  // ── Derived ──
  const detail     = vehicles.find(v => v.id === detailVehicleId);
  const vParts     = (id) => parts.filter(p => p.vehicleId === id);
  const vNotes     = (id) => notes.filter(n => n.vehicleId === id).sort((a,b) => (a.ts?.seconds||0)-(b.ts?.seconds||0));
  const vPhotos    = (id) => photos.filter(p => p.vehicleId === id).sort((a,b) => (a.ts?.seconds||0)-(b.ts?.seconds||0));
  const vCost      = (id) => parts.filter(p => p.vehicleId === id).reduce((a,p) => a+(parseFloat(p.cost)||0), 0);
  const vJobs      = (id) => vendorJobs.filter(j => j.vehicleId === id);
  const vendorById = (id) => vendors.find(v => v.id === id);
  const userById   = (id) => users.find(u => u.id === id);
  const canEdit    = currentUser && ["admin","manager","tech"].includes(currentUser.role);
  const isAdmin    = currentUser?.role === "admin";

  const filtered = vehicles.filter(v => {
    const q = searchQ.toLowerCase();
    const mQ = !q || `${v.year} ${v.make} ${v.model} ${v.vin} ${v.stock}`.toLowerCase().includes(q);
    const mS = !stageFilter || v.stage === stageFilter;
    return mQ && mS;
  });

  const stageCounts = STAGES.reduce((a,s) => { a[s.id] = vehicles.filter(v=>v.stage===s.id).length; return a; }, {});
  const totalCost   = parts.reduce((a,p) => a+(parseFloat(p.cost)||0), 0);

  // ── Auth ──
  function handleLogin() {
    const u = users.find(u => u.name.toLowerCase()===loginName.toLowerCase() && u.pin===loginPin);
    if (u) { setCurrentUser(u); setLoginError(""); setLoginPin(""); }
    else setLoginError("Name or PIN not found.");
  }

  // ── Vehicle actions ──
  async function addVehicle() {
    if (!newV.make && !newV.model) return;
    await addDoc(col("vehicles"), { ...newV, addedAt: serverTimestamp(), addedBy: currentUser.id });
    setNewV(blankVehicle());
    setAddingVehicle(false);
  }
  async function moveStage(id, dir) {
    const v = vehicles.find(v => v.id === id);
    if (!v) return;
    const i = STAGE_IDS.indexOf(v.stage);
    const next = STAGE_IDS[Math.min(Math.max(i+dir,0), STAGE_IDS.length-1)];
    await updateDoc(doc(db,"vehicles",id), { stage: next });
  }
  async function setStage(id, stage) {
    await updateDoc(doc(db,"vehicles",id), { stage });
  }
  async function deleteVehicle(id) {
    await deleteDoc(doc(db,"vehicles",id));
    // Clean up related data
    parts.filter(p=>p.vehicleId===id).forEach(p => deleteDoc(doc(db,"parts",p.id)));
    notes.filter(n=>n.vehicleId===id).forEach(n => deleteDoc(doc(db,"notes",n.id)));
    vendorJobs.filter(j=>j.vehicleId===id).forEach(j => deleteDoc(doc(db,"vendorJobs",j.id)));
    photos.filter(ph=>ph.vehicleId===id).forEach(ph => {
      if (ph.storagePath) deleteObject(storageRef(storage, ph.storagePath)).catch(()=>{});
      deleteDoc(doc(db,"photos",ph.id));
    });
    setDetailVehicleId(null);
    setConfirmDelete(null);
  }

  // ── Notes ──
  async function addNote() {
    if (!noteInput.trim() || !detail) return;
    await addDoc(col("notes"), { vehicleId: detail.id, text: noteInput.trim(), ts: serverTimestamp(), userId: currentUser.id });
    setNoteInput("");
  }
  async function deleteNote(id) { await deleteDoc(doc(db,"notes",id)); }

  // ── Parts ──
  async function addPart() {
    if (!newPart.name.trim() || !detail) return;
    await addDoc(col("parts"), { ...newPart, vehicleId: detail.id, addedBy: currentUser.id, ts: serverTimestamp() });
    setNewPart({ name:"", cost:"", status:"ordered", vendorId:"" });
  }
  async function deletePart(id) { await deleteDoc(doc(db,"parts",id)); }
  async function updatePartStatus(id, status) { await updateDoc(doc(db,"parts",id), { status }); }

  // ── Photos ──
  async function handlePhotoUpload(e) {
    if (!detail) return;
    const files = Array.from(e.target.files);
    setUploading(true);
    for (const file of files) {
      try {
        const path = `photos/${detail.id}/${uid()}_${file.name}`;
        const sRef = storageRef(storage, path);
        await uploadBytes(sRef, file);
        const url = await getDownloadURL(sRef);
        await addDoc(col("photos"), {
          vehicleId: detail.id, url, storagePath: path,
          caption: photoCaption || file.name,
          uploadedBy: currentUser.id, ts: serverTimestamp()
        });
      } catch (err) {
        console.error("Upload failed:", err);
      }
    }
    setUploading(false);
    setPhotoCaption("");
    e.target.value = "";
  }
  async function deletePhoto(photo) {
    if (photo.storagePath) {
      try { await deleteObject(storageRef(storage, photo.storagePath)); } catch {}
    }
    await deleteDoc(doc(db,"photos",photo.id));
  }

  // ── Users ──
  async function addUser() {
    if (!newUser.name.trim() || !newUser.pin.trim()) return;
    await setDoc(doc(db,"users", uid()), { ...newUser, createdAt: serverTimestamp() });
    setNewUser({ name:"", pin:"", role:"tech" });
    setAddingUser(false);
  }
  async function deleteUser(id) {
    if (id === currentUser.id) return;
    await deleteDoc(doc(db,"users",id));
  }

  // ── Vendors ──
  async function addVendor() {
    if (!newVendor.name.trim()) return;
    await addDoc(col("vendors"), { ...newVendor, createdAt: serverTimestamp() });
    setNewVendor({ name:"", type:"Mechanical", phone:"", contact:"", notes:"" });
    setAddingVendor(false);
  }
  async function deleteVendor(id) {
    await deleteDoc(doc(db,"vendors",id));
    vendorJobs.filter(j=>j.vendorId===id).forEach(j => deleteDoc(doc(db,"vendorJobs",j.id)));
  }

  // ── Vendor Jobs ──
  async function addVendorJob() {
    if (!newJob.vendorId || !newJob.description.trim() || !detail) return;
    await addDoc(col("vendorJobs"), { ...newJob, vehicleId: detail.id, addedBy: currentUser.id, createdAt: serverTimestamp() });
    setNewJob({ vendorId:"", description:"", cost:"", status:"pending" });
    setAddingJob(false);
  }
  async function updateJobStatus(id, status) { await updateDoc(doc(db,"vendorJobs",id), { status }); }
  async function deleteJob(id) { await deleteDoc(doc(db,"vendorJobs",id)); }

  // ── Screens ──
  // Show minimal splash only for first ~2 seconds while users collection loads
  if (!loaded) return (
    <div style={S.loginWrap}>
      <div style={S.loginBox}>
        <div style={{fontSize:"2.5rem"}}>🔧</div>
        <div style={S.loginTitle}>RECON TRACKER</div>
        <div style={{color:"#475569",fontSize:".75rem",marginTop:4,display:"flex",alignItems:"center",gap:8}}>
          <span style={{display:"inline-block",width:12,height:12,borderRadius:"50%",border:"2px solid #2563EB",borderTopColor:"transparent",animation:"spin 0.8s linear infinite"}} />
          Connecting…
        </div>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );

  if (!currentUser) return (
    <div style={S.loginWrap}>
      <div style={S.loginBox}>
        <div style={{fontSize:"2.5rem"}}>🔧</div>
        <div style={S.loginTitle}>RECON TRACKER</div>
        <div style={S.loginSub}>Sign in to continue</div>
        <div style={{display:"flex",flexDirection:"column",gap:10,width:"100%",marginTop:8}}>
          <input style={S.loginInput} placeholder="Your name" value={loginName} onChange={e=>setLoginName(e.target.value)} />
          <input style={S.loginInput} placeholder="PIN" type="password" maxLength={8} value={loginPin}
            onChange={e=>setLoginPin(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleLogin()} />
        </div>
        {loginError && <div style={{color:"#F87171",fontSize:".78rem"}}>{loginError}</div>}
        <button style={S.loginBtn} onClick={handleLogin}>Sign In</button>
      
      </div>
    </div>
  );

  // ── Main App ──
  return (
    <div style={S.root}>

      {/* Header */}
      <header style={S.header}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:"1.5rem"}}>🔧</span>
          <div>
            <div style={S.logoTitle}>RECON TRACKER</div>
            <div style={S.logoSub}>Vehicle Reconditioning Pipeline</div>
          </div>
        </div>

        <div style={S.headerStats}>
          <Stat label="Vehicles"    value={vehicles.length} />
          <Stat label="In Pipeline" value={vehicles.filter(v=>v.stage!=="frontline").length} />
          <Stat label="Front Line"  value={vehicles.filter(v=>v.stage==="frontline").length} color="#86EFAC" />
          <Stat label="Parts Cost"  value={fmt$(totalCost)} color="#FCD34D" />
          <Stat label="Vendors"     value={vendors.length} color="#C4B5FD" />
        </div>

        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <div style={{display:"flex",gap:4}}>
            {[["board","📋 Board"],["vendors","🏢 Vendors"],...(isAdmin?[["users","👥 Users"]]:[])]
              .map(([v,l]) => (
              <button key={v} style={{...S.navTab,...(view===v?S.navTabActive:{})}} onClick={()=>setView(v)}>{l}</button>
            ))}
          </div>
          <div style={S.userChip}>
            <div style={{...S.avatar,background:avatarColor(currentUser.name)}}>{initials(currentUser.name)}</div>
            <div>
              <div style={{fontSize:".72rem",fontWeight:700,color:"#E2E8F0"}}>{currentUser.name}</div>
              <div style={{fontSize:".58rem",color:"#64748B",textTransform:"uppercase",letterSpacing:".05em"}}>{ROLES[currentUser.role]}</div>
            </div>
            <button style={{background:"transparent",border:"none",color:"#475569",cursor:"pointer",fontSize:".9rem",marginLeft:4}} onClick={()=>setCurrentUser(null)}>⏻</button>
          </div>
          {canEdit && view==="board" && (
            <button style={S.addBtn} onClick={()=>setAddingVehicle(true)}>+ Vehicle</button>
          )}
        </div>
      </header>

      {/* ══ BOARD ══ */}
      {view==="board" && (<>
        <div style={S.toolbar}>
          <input style={S.search} placeholder="Search VIN, stock#, make, model…" value={searchQ} onChange={e=>setSearchQ(e.target.value)} />
          <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
            <button style={{...S.filterBtn,...(!stageFilter?S.filterActive:{})}} onClick={()=>setStageFilter(null)}>All</button>
            {STAGES.map(s=>(
              <button key={s.id} style={{...S.filterBtn,...(stageFilter===s.id?{background:s.color,color:"#fff",borderColor:s.color}:{})}}
                onClick={()=>setStageFilter(stageFilter===s.id?null:s.id)}>
                {s.label}
                {stageCounts[s.id]>0 && <span style={{...S.filterCount,background:stageFilter===s.id?"rgba(255,255,255,.25)":s.color}}>{stageCounts[s.id]}</span>}
              </button>
            ))}
          </div>
        </div>

        <div style={S.board}>
          {STAGES.map(stage=>{
            const svs = filtered.filter(v=>v.stage===stage.id);
            return (
              <div key={stage.id} style={S.col}>
                <div style={{...S.colHead,borderColor:stage.color}}>
                  <span style={{color:stage.accent,fontWeight:700,fontSize:".73rem",letterSpacing:".08em",textTransform:"uppercase"}}>{stage.label}</span>
                  <span style={{...S.colCount,background:stage.color}}>{svs.length}</span>
                </div>
                <div style={S.colBody}>
                  {svs.length===0 && <div style={S.emptyCol}>—</div>}
                  {svs.map(v=>(
                    <VehicleCard key={v.id} vehicle={v} stage={stage}
                      cost={vCost(v.id)} partCount={vParts(v.id).length}
                      noteCount={vNotes(v.id).length} photoCount={vPhotos(v.id).length}
                      jobCount={vJobs(v.id).length}
                      onOpen={()=>{setDetailVehicleId(v.id);setDetailTab("info");}}
                      onMove={canEdit?(dir=>moveStage(v.id,dir)):null}
                      stageIdx={STAGE_IDS.indexOf(v.stage)} totalStages={STAGES.length}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </>)}

      {/* ══ VENDORS ══ */}
      {view==="vendors" && (
        <div style={S.pageWrap}>
          <div style={S.pageHeader}>
            <div style={S.pageTitle}>🏢 Vendor Directory</div>
            <div style={{fontSize:".78rem",color:"#64748B",flex:1}}>Shops and contractors you send vehicles to</div>
            {canEdit && <button style={S.addBtn} onClick={()=>setAddingVendor(true)}>+ Add Vendor</button>}
          </div>
          {vendors.length===0 && (
            <div style={{textAlign:"center",paddingTop:60}}>
              <div style={{fontSize:"3rem",marginBottom:12}}>🏢</div>
              <div style={{color:"#94A3B8",fontSize:".9rem"}}>No vendors yet.</div>
              <div style={{color:"#475569",fontSize:".8rem",marginTop:6}}>Add body shops, detailers, mechanics — anyone you send vehicles to.</div>
            </div>
          )}
          <div style={S.vendorGrid}>
            {vendors.map(v=>{
              const jobs = vendorJobs.filter(j=>j.vendorId===v.id);
              const spend = jobs.reduce((a,j)=>a+(parseFloat(j.cost)||0),0);
              return (
                <div key={v.id} style={S.vendorCard} onClick={()=>setVendorDetail(v.id)}>
                  <div style={{display:"flex",gap:12,alignItems:"center"}}>
                    <div style={{...S.vendorIcon,background:avatarColor(v.name)}}>{v.name[0].toUpperCase()}</div>
                    <div>
                      <div style={{fontSize:".88rem",fontWeight:700,color:"#F1F5F9"}}>{v.name}</div>
                      <div style={{fontSize:".68rem",color:"#7C3AED",textTransform:"uppercase",letterSpacing:".04em"}}>{v.type}</div>
                    </div>
                  </div>
                  {v.contact && <div style={{fontSize:".72rem",color:"#64748B"}}>👤 {v.contact}</div>}
                  {v.phone   && <div style={{fontSize:".72rem",color:"#64748B"}}>📞 {v.phone}</div>}
                  <div style={{display:"flex",gap:14,borderTop:"1px solid #1E293B",paddingTop:8,marginTop:2}}>
                    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
                      <span style={{color:"#FCD34D",fontWeight:700}}>{fmt$(spend)}</span>
                      <span style={{fontSize:".6rem",color:"#475569",textTransform:"uppercase"}}>spent</span>
                    </div>
                    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
                      <span style={{color:"#93C5FD",fontWeight:700}}>{jobs.length}</span>
                      <span style={{fontSize:".6rem",color:"#475569",textTransform:"uppercase"}}>jobs</span>
                    </div>
                    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
                      <span style={{color:"#6EE7B7",fontWeight:700}}>{jobs.filter(j=>j.status==="in_progress").length}</span>
                      <span style={{fontSize:".6rem",color:"#475569",textTransform:"uppercase"}}>active</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ══ USERS ══ */}
      {view==="users" && isAdmin && (
        <div style={S.pageWrap}>
          <div style={S.pageHeader}>
            <div style={S.pageTitle}>👥 Users</div>
            <div style={{fontSize:".78rem",color:"#64748B",flex:1}}>Manage access and roles</div>
            <button style={S.addBtn} onClick={()=>setAddingUser(true)}>+ Add User</button>
          </div>
          <div style={S.userTable}>
            <div style={S.userTableHead}>
              {["Name","Role","PIN",""].map((h,i)=><div key={i} style={S.thCell}>{h}</div>)}
            </div>
            {users.map(u=>(
              <div key={u.id} style={S.userRow}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{...S.avatar,background:avatarColor(u.name)}}>{initials(u.name)}</div>
                  <span style={{fontSize:".85rem",color:"#E2E8F0"}}>{u.name}</span>
                  {u.id===currentUser.id && <span style={{background:"#1E3A5F",color:"#93C5FD",fontSize:".6rem",padding:"1px 7px",borderRadius:8,fontWeight:600}}>you</span>}
                </div>
                <div style={roleBadgeStyle(u.role)}>{ROLES[u.role]}</div>
                <div style={{fontSize:".78rem",color:"#475569",fontFamily:"monospace"}}>{"•".repeat((u.pin||"").length)}</div>
                <div>{u.id!==currentUser.id && <button style={S.deleteSmall} onClick={()=>deleteUser(u.id)}>Remove</button>}</div>
              </div>
            ))}
          </div>
          <div style={{background:"#1E293B",border:"1px solid #334155",borderRadius:9,padding:16,display:"flex",flexDirection:"column",gap:10}}>
            <div style={{fontSize:".7rem",letterSpacing:".08em",textTransform:"uppercase",color:"#475569",fontWeight:700,marginBottom:4}}>Role Permissions</div>
            {[["admin","Full access — manage users, vendors, vehicles, all data"],
              ["manager","Add/edit vehicles, parts, notes, photos, vendors. Cannot manage users."],
              ["tech","Add parts, notes, photos. Move vehicles between stages."],
              ["viewer","Read-only. Cannot add or change anything."]
            ].map(([r,d])=>(
              <div key={r} style={{display:"flex",gap:12,alignItems:"flex-start"}}>
                <div style={roleBadgeStyle(r)}>{ROLES[r]}</div>
                <div style={{fontSize:".78rem",color:"#94A3B8"}}>{d}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══ ADD VEHICLE MODAL ══ */}
      {addingVehicle && (
        <Modal title="Add Vehicle" onClose={()=>setAddingVehicle(false)}>
          <div style={S.formGrid}>
            {[["Year","year","e.g. 2021"],["Make","make","e.g. Chevrolet"],["Model","model","e.g. Silverado"],["VIN","vin","17-char VIN"],["Stock #","stock","e.g. U1234"]].map(([l,f,ph])=>(
              <div key={f} style={S.formField}>
                <label style={S.formLabel}>{l}</label>
                <input style={S.formInput} placeholder={ph} value={newV[f]} onChange={e=>setNewV(p=>({...p,[f]:e.target.value}))} />
              </div>
            ))}
            <div style={S.formField}>
              <label style={S.formLabel}>Starting Stage</label>
              <select style={S.formInput} value={newV.stage} onChange={e=>setNewV(p=>({...p,stage:e.target.value}))}>
                {STAGES.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
          </div>
          <div style={S.modalActions}>
            <button style={S.cancelBtn} onClick={()=>setAddingVehicle(false)}>Cancel</button>
            <button style={S.saveBtn} onClick={addVehicle}>Add Vehicle</button>
          </div>
        </Modal>
      )}

      {/* ══ ADD USER MODAL ══ */}
      {addingUser && (
        <Modal title="Add User" onClose={()=>setAddingUser(false)}>
          <div style={S.formGrid}>
            <div style={S.formField}>
              <label style={S.formLabel}>Full Name</label>
              <input style={S.formInput} placeholder="e.g. John Smith" value={newUser.name} onChange={e=>setNewUser(p=>({...p,name:e.target.value}))} />
            </div>
            <div style={S.formField}>
              <label style={S.formLabel}>PIN (4–8 digits)</label>
              <input style={S.formInput} placeholder="e.g. 5678" type="password" maxLength={8} value={newUser.pin} onChange={e=>setNewUser(p=>({...p,pin:e.target.value}))} />
            </div>
            <div style={{...S.formField,gridColumn:"1/-1"}}>
              <label style={S.formLabel}>Role</label>
              <select style={S.formInput} value={newUser.role} onChange={e=>setNewUser(p=>({...p,role:e.target.value}))}>
                {Object.entries(ROLES).map(([k,v])=><option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          </div>
          <div style={S.modalActions}>
            <button style={S.cancelBtn} onClick={()=>setAddingUser(false)}>Cancel</button>
            <button style={S.saveBtn} onClick={addUser}>Add User</button>
          </div>
        </Modal>
      )}

      {/* ══ ADD VENDOR MODAL ══ */}
      {addingVendor && (
        <Modal title="Add Vendor" onClose={()=>setAddingVendor(false)}>
          <div style={S.formGrid}>
            <div style={{...S.formField,gridColumn:"1/-1"}}>
              <label style={S.formLabel}>Business Name</label>
              <input style={S.formInput} placeholder="e.g. Mike's Body Shop" value={newVendor.name} onChange={e=>setNewVendor(p=>({...p,name:e.target.value}))} />
            </div>
            <div style={S.formField}>
              <label style={S.formLabel}>Type</label>
              <select style={S.formInput} value={newVendor.type} onChange={e=>setNewVendor(p=>({...p,type:e.target.value}))}>
                {VENDOR_TYPES.map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
            <div style={S.formField}>
              <label style={S.formLabel}>Phone</label>
              <input style={S.formInput} placeholder="(555) 555-5555" value={newVendor.phone} onChange={e=>setNewVendor(p=>({...p,phone:e.target.value}))} />
            </div>
            <div style={S.formField}>
              <label style={S.formLabel}>Contact Name</label>
              <input style={S.formInput} placeholder="Primary contact" value={newVendor.contact} onChange={e=>setNewVendor(p=>({...p,contact:e.target.value}))} />
            </div>
            <div style={{...S.formField,gridColumn:"1/-1"}}>
              <label style={S.formLabel}>Notes</label>
              <input style={S.formInput} placeholder="Turnaround time, specialties…" value={newVendor.notes} onChange={e=>setNewVendor(p=>({...p,notes:e.target.value}))} />
            </div>
          </div>
          <div style={S.modalActions}>
            <button style={S.cancelBtn} onClick={()=>setAddingVendor(false)}>Cancel</button>
            <button style={S.saveBtn} onClick={addVendor}>Add Vendor</button>
          </div>
        </Modal>
      )}

      {/* ══ VENDOR DETAIL MODAL ══ */}
      {vendorDetail && (()=>{
        const vnd = vendors.find(v=>v.id===vendorDetail);
        if (!vnd) return null;
        const jobs = vendorJobs.filter(j=>j.vendorId===vnd.id);
        const spend = jobs.reduce((a,j)=>a+(parseFloat(j.cost)||0),0);
        return (
          <Modal title={vnd.name} onClose={()=>setVendorDetail(null)}>
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              <div style={{display:"flex",flexDirection:"column",gap:5}}>
                <InfoRow label="Type"    value={vnd.type} />
                {vnd.contact && <InfoRow label="Contact" value={vnd.contact} />}
                {vnd.phone   && <InfoRow label="Phone"   value={vnd.phone} />}
                {vnd.notes   && <InfoRow label="Notes"   value={vnd.notes} />}
                <InfoRow label="Total Spend" value={fmt$(spend)} highlight />
                <InfoRow label="Total Jobs"  value={jobs.length} />
              </div>
              <Section title="Job History">
                {jobs.length===0 && <div style={S.emptyText}>No jobs yet.</div>}
                {jobs.map(j=>{
                  const jv = vehicles.find(v=>v.id===j.vehicleId);
                  return (
                    <div key={j.id} style={S.partRow}>
                      <div style={{flex:1}}>
                        <div style={{fontSize:".8rem",color:"#E2E8F0"}}>{j.description}</div>
                        {jv && <div style={{fontSize:".68rem",color:"#64748B"}}>{jv.year} {jv.make} {jv.model} · Stock #{jv.stock||"—"}</div>}
                      </div>
                      <div style={{fontSize:".8rem",color:"#FCD34D",minWidth:55,textAlign:"right"}}>{fmt$(j.cost)}</div>
                      <span style={{...S.statusBadge,background:jobStatusColor(j.status)}}>{jobStatusLabel(j.status)}</span>
                    </div>
                  );
                })}
              </Section>
              {isAdmin && <button style={S.deleteBtn} onClick={()=>{deleteVendor(vnd.id);setVendorDetail(null);}}>🗑 Remove Vendor</button>}
            </div>
          </Modal>
        );
      })()}

      {/* ══ VEHICLE DETAIL MODAL ══ */}
      {detail && (
        <Modal title={`${detail.year} ${detail.make} ${detail.model}`} wide onClose={()=>setDetailVehicleId(null)}>
          {/* Tabs */}
          <div style={S.tabBar}>
            {[["info","ℹ️ Info"],["parts","🔩 Parts"],["photos","📷 Photos"],["vendors","🏢 Vendors"],["notes","📝 Notes"]].map(([t,l])=>(
              <button key={t} style={{...S.tabBtn,...(detailTab===t?S.tabBtnActive:{})}} onClick={()=>setDetailTab(t)}>
                {l}
                {t==="parts"   && vParts(detail.id).length>0  && <span style={S.tabBadge}>{vParts(detail.id).length}</span>}
                {t==="photos"  && vPhotos(detail.id).length>0 && <span style={S.tabBadge}>{vPhotos(detail.id).length}</span>}
                {t==="notes"   && vNotes(detail.id).length>0  && <span style={S.tabBadge}>{vNotes(detail.id).length}</span>}
                {t==="vendors" && vJobs(detail.id).length>0   && <span style={S.tabBadge}>{vJobs(detail.id).length}</span>}
              </button>
            ))}
          </div>

          <div style={{padding:"16px 18px",overflowY:"auto",maxHeight:"65vh"}}>

            {/* INFO */}
            {detailTab==="info" && (
              <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
                <div style={{flex:"1 1 210px",display:"flex",flexDirection:"column",gap:14}}>
                  <Section title="Vehicle Info">
                    <InfoRow label="VIN"    value={detail.vin   ||"—"} />
                    <InfoRow label="Stock #" value={detail.stock ||"—"} />
                    <InfoRow label="Added"   value={daysAgo(detail.addedAt)} />
                    {detail.addedBy && <InfoRow label="Added By" value={userById(detail.addedBy)?.name||"—"} />}
                    <InfoRow label="Parts Cost" value={fmt$(vCost(detail.id))} highlight />
                  </Section>
                </div>
                <div style={{flex:"1 1 210px"}}>
                  <Section title="Pipeline Stage">
                    <div style={{display:"flex",flexDirection:"column",gap:4,marginTop:4}}>
                      {STAGES.map((s,i)=>(
                        <button key={s.id} style={{...S.stageBtn,background:detail.stage===s.id?s.color:"transparent",borderColor:s.color,color:detail.stage===s.id?"#fff":s.accent}}
                          onClick={()=>canEdit&&setStage(detail.id,s.id)}>
                          <span style={{fontSize:".65rem",opacity:.6,marginRight:6}}>{i+1}.</span>{s.label}
                        </button>
                      ))}
                    </div>
                  </Section>
                </div>
                {canEdit && (
                  <div style={{width:"100%",marginTop:8}}>
                    {confirmDelete===detail.id ? (
                      <div style={{background:"#1E293B",border:"1px solid #7F1D1D",borderRadius:7,padding:12}}>
                        <div style={{color:"#F87171",fontSize:".85rem",marginBottom:8}}>Delete this vehicle and all its data?</div>
                        <div style={{display:"flex",gap:8}}>
                          <button style={S.deleteBtn} onClick={()=>deleteVehicle(detail.id)}>Yes, Delete</button>
                          <button style={S.cancelBtn} onClick={()=>setConfirmDelete(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <button style={S.deleteBtn} onClick={()=>setConfirmDelete(detail.id)}>🗑 Remove Vehicle</button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* PARTS */}
            {detailTab==="parts" && (
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{fontSize:".82rem",color:"#94A3B8"}}>Total: <strong style={{color:"#FCD34D"}}>{fmt$(vCost(detail.id))}</strong></div>
                {canEdit && (
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    <input style={{...S.partInput,flex:2}} placeholder="Part / labor description" value={newPart.name} onChange={e=>setNewPart(p=>({...p,name:e.target.value}))} />
                    <input style={{...S.partInput,width:90}} placeholder="Cost $" type="number" value={newPart.cost} onChange={e=>setNewPart(p=>({...p,cost:e.target.value}))} />
                    <select style={{...S.partInput,width:110}} value={newPart.status} onChange={e=>setNewPart(p=>({...p,status:e.target.value}))}>
                      <option value="ordered">Ordered</option><option value="received">Received</option>
                      <option value="installed">Installed</option><option value="pending">Pending</option>
                    </select>
                    <select style={{...S.partInput,width:140}} value={newPart.vendorId} onChange={e=>setNewPart(p=>({...p,vendorId:e.target.value}))}>
                      <option value="">No vendor</option>
                      {vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                    <button style={S.saveBtn} onClick={addPart}>Add</button>
                  </div>
                )}
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  {vParts(detail.id).length===0 && <div style={S.emptyText}>No parts added yet.</div>}
                  {vParts(detail.id).map(p=>(
                    <div key={p.id} style={S.partRow}>
                      <div style={{flex:1}}>
                        <div style={{fontSize:".8rem",color:"#E2E8F0"}}>{p.name}</div>
                        {p.vendorId && vendorById(p.vendorId) && <div style={{fontSize:".65rem",color:"#7C3AED"}}>📦 {vendorById(p.vendorId).name}</div>}
                      </div>
                      <div style={{fontSize:".8rem",color:"#FCD34D",minWidth:55,textAlign:"right"}}>{fmt$(p.cost)}</div>
                      {canEdit ? (
                        <select style={{...S.statusBadge,background:partStatusColor(p.status),border:"none",cursor:"pointer"}} value={p.status} onChange={e=>updatePartStatus(p.id,e.target.value)}>
                          <option value="ordered">Ordered</option><option value="received">Received</option>
                          <option value="installed">Installed</option><option value="pending">Pending</option>
                        </select>
                      ) : <span style={{...S.statusBadge,background:partStatusColor(p.status)}}>{p.status}</span>}
                      {canEdit && <button style={S.deleteSmall} onClick={()=>deletePart(p.id)}>✕</button>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* PHOTOS */}
            {detailTab==="photos" && (
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                {canEdit && (
                  <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                    <input style={{...S.partInput,flex:2}} placeholder="Caption (optional)" value={photoCaption} onChange={e=>setPhotoCaption(e.target.value)} />
                    <button style={{...S.saveBtn,...(uploading?{opacity:.6}:{})}} disabled={uploading} onClick={()=>fileInputRef.current.click()}>
                      {uploading?"Uploading…":"📷 Upload Photos"}
                    </button>
                    <input ref={fileInputRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={handlePhotoUpload} />
                  </div>
                )}
                {vPhotos(detail.id).length===0 && <div style={S.emptyText}>No photos yet. Upload damage, before/after, or completed work shots.</div>}
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:10}}>
                  {vPhotos(detail.id).map((ph,idx)=>(
                    <div key={ph.id} style={{position:"relative",height:110,borderRadius:7,overflow:"hidden",cursor:"pointer",border:"1px solid #334155"}}
                      onClick={()=>setLightbox({photos:vPhotos(detail.id),idx})}>
                      <img src={ph.url} alt={ph.caption} style={{width:"100%",height:"100%",objectFit:"cover"}} />
                      <div style={{position:"absolute",bottom:0,left:0,right:0,background:"rgba(0,0,0,.65)",padding:"5px 7px"}}>
                        <div style={{fontSize:".65rem",color:"#E2E8F0",lineHeight:1.2}}>{ph.caption}</div>
                        <div style={{fontSize:".6rem",color:"#94A3B8"}}>{userById(ph.uploadedBy)?.name||"—"}</div>
                      </div>
                      {canEdit && (
                        <button style={{position:"absolute",top:5,right:5,background:"rgba(0,0,0,.6)",border:"none",color:"#fff",borderRadius:"50%",width:20,height:20,cursor:"pointer",fontSize:".65rem",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center"}}
                          onClick={e=>{e.stopPropagation();deletePhoto(ph);}}>✕</button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* VENDOR JOBS */}
            {detailTab==="vendors" && (
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{fontSize:".82rem",color:"#94A3B8"}}>
                  Vendor jobs · Total: <strong style={{color:"#FCD34D"}}>{fmt$(vJobs(detail.id).reduce((a,j)=>a+(parseFloat(j.cost)||0),0))}</strong>
                </div>
                {canEdit && vendors.length>0 && (
                  addingJob ? (
                    <div style={{background:"#0F172A",border:"1px solid #334155",borderRadius:7,padding:12,display:"flex",flexDirection:"column",gap:8}}>
                      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                        <select style={{...S.partInput,flex:1}} value={newJob.vendorId} onChange={e=>setNewJob(p=>({...p,vendorId:e.target.value}))}>
                          <option value="">Select vendor…</option>
                          {vendors.map(v=><option key={v.id} value={v.id}>{v.name} ({v.type})</option>)}
                        </select>
                        <input style={{...S.partInput,flex:2}} placeholder="Work description" value={newJob.description} onChange={e=>setNewJob(p=>({...p,description:e.target.value}))} />
                        <input style={{...S.partInput,width:90}} placeholder="Est. cost $" type="number" value={newJob.cost} onChange={e=>setNewJob(p=>({...p,cost:e.target.value}))} />
                        <select style={{...S.partInput,width:130}} value={newJob.status} onChange={e=>setNewJob(p=>({...p,status:e.target.value}))}>
                          <option value="pending">Pending</option><option value="in_progress">In Progress</option>
                          <option value="completed">Completed</option><option value="cancelled">Cancelled</option>
                        </select>
                      </div>
                      <div style={{display:"flex",gap:8}}>
                        <button style={S.saveBtn} onClick={addVendorJob}>Assign Job</button>
                        <button style={S.cancelBtn} onClick={()=>setAddingJob(false)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button style={S.saveBtn} onClick={()=>setAddingJob(true)}>+ Assign Vendor Job</button>
                  )
                )}
                {vendors.length===0 && <div style={S.emptyText}>No vendors in directory yet. Add vendors from the Vendors tab first.</div>}
                {vJobs(detail.id).length===0 && vendors.length>0 && <div style={S.emptyText}>No vendor jobs assigned to this vehicle.</div>}
                {vJobs(detail.id).map(j=>{
                  const vnd = vendorById(j.vendorId);
                  return (
                    <div key={j.id} style={S.partRow}>
                      <div style={{flex:1}}>
                        <div style={{fontSize:".8rem",color:"#E2E8F0"}}>{j.description}</div>
                        {vnd && <div style={{fontSize:".68rem",color:"#C4B5FD"}}>🏢 {vnd.name} · {vnd.type}</div>}
                      </div>
                      <div style={{fontSize:".8rem",color:"#FCD34D",minWidth:55,textAlign:"right"}}>{fmt$(j.cost)}</div>
                      {canEdit ? (
                        <select style={{...S.statusBadge,background:jobStatusColor(j.status),border:"none",cursor:"pointer"}} value={j.status} onChange={e=>updateJobStatus(j.id,e.target.value)}>
                          <option value="pending">Pending</option><option value="in_progress">In Progress</option>
                          <option value="completed">Completed</option><option value="cancelled">Cancelled</option>
                        </select>
                      ) : <span style={{...S.statusBadge,background:jobStatusColor(j.status)}}>{jobStatusLabel(j.status)}</span>}
                      {canEdit && <button style={S.deleteSmall} onClick={()=>deleteJob(j.id)}>✕</button>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* NOTES */}
            {detailTab==="notes" && (
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <div style={{display:"flex",flexDirection:"column",gap:7,maxHeight:320,overflowY:"auto"}}>
                  {vNotes(detail.id).length===0 && <div style={S.emptyText}>No notes yet.</div>}
                  {vNotes(detail.id).map(n=>{
                    const author = userById(n.userId);
                    return (
                      <div key={n.id} style={{background:"#0F172A",borderRadius:6,padding:"9px 11px",border:"1px solid #1E293B"}}>
                        <div style={{fontSize:".82rem",color:"#CBD5E1",lineHeight:1.4}}>{n.text}</div>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:5}}>
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            {author && <div style={{...S.avatar,width:18,height:18,fontSize:".55rem",background:avatarColor(author.name)}}>{initials(author.name)}</div>}
                            <span style={{fontSize:".65rem",color:"#475569"}}>{author?.name||"Unknown"} · {n.ts?.toDate?.().toLocaleString()||"—"}</span>
                          </div>
                          {canEdit && <button style={S.deleteSmall} onClick={()=>deleteNote(n.id)}>✕</button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {canEdit && (
                  <div style={{display:"flex",gap:8,alignItems:"flex-start"}}>
                    <textarea style={{flex:1,background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",padding:"7px 10px",borderRadius:5,fontFamily:"inherit",fontSize:".82rem",outline:"none",resize:"none"}}
                      rows={2} placeholder="Add a note…" value={noteInput} onChange={e=>setNoteInput(e.target.value)}
                      onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();addNote();}}} />
                    <button style={S.saveBtn} onClick={addNote}>Add</button>
                  </div>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* ══ LIGHTBOX ══ */}
      {lightbox && (
        <div style={{...S.overlay,zIndex:200}} onClick={()=>setLightbox(null)}>
          <div style={{position:"relative",maxWidth:"90vw",maxHeight:"90vh"}} onClick={e=>e.stopPropagation()}>
            <img src={lightbox.photos[lightbox.idx].url} alt="" style={{maxWidth:"90vw",maxHeight:"80vh",borderRadius:8,objectFit:"contain"}} />
            <div style={{color:"#94A3B8",fontSize:".8rem",textAlign:"center",marginTop:8}}>{lightbox.photos[lightbox.idx].caption}</div>
            <div style={{display:"flex",justifyContent:"center",gap:16,marginTop:10}}>
              <button style={S.lbBtn} disabled={lightbox.idx===0} onClick={()=>setLightbox(p=>({...p,idx:p.idx-1}))}>◀ Prev</button>
              <span style={{color:"#475569",fontSize:".8rem",alignSelf:"center"}}>{lightbox.idx+1} / {lightbox.photos.length}</span>
              <button style={S.lbBtn} disabled={lightbox.idx===lightbox.photos.length-1} onClick={()=>setLightbox(p=>({...p,idx:p.idx+1}))}>Next ▶</button>
            </div>
            <button style={{...S.cancelBtn,position:"absolute",top:-36,right:0}} onClick={()=>setLightbox(null)}>✕ Close</button>
          </div>
        </div>
      )}

    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function VehicleCard({vehicle,stage,cost,partCount,noteCount,photoCount,jobCount,onOpen,onMove,stageIdx,totalStages}) {
  return (
    <div style={S.card} onClick={onOpen}>
      <div style={{height:3,background:stage.color}} />
      <div style={{padding:"9px 10px 5px"}}>
        <div style={{fontSize:".82rem",fontWeight:700,color:"#F1F5F9",lineHeight:1.3}}>{vehicle.year} {vehicle.make} {vehicle.model||"—"}</div>
        {vehicle.stock && <div style={{fontSize:".7rem",color:"#64748B",marginTop:1}}>Stock #{vehicle.stock}</div>}
        {vehicle.vin   && <div style={{fontSize:".65rem",color:"#334155",fontFamily:"monospace",marginTop:1}}>{vehicle.vin}</div>}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:5}}>
          <span style={{fontSize:".62rem",color:"#475569"}}>{daysAgo(vehicle.addedAt)}</span>
          {cost>0 && <span style={{fontSize:".7rem",color:"#FCD34D",fontWeight:600}}>{fmt$(cost)}</span>}
        </div>
        <div style={{display:"flex",gap:4,marginTop:4,flexWrap:"wrap"}}>
          {partCount>0  && <span style={S.badge}>🔩{partCount}</span>}
          {noteCount>0  && <span style={S.badge}>📝{noteCount}</span>}
          {photoCount>0 && <span style={S.badge}>📷{photoCount}</span>}
          {jobCount>0   && <span style={S.badge}>🏢{jobCount}</span>}
        </div>
      </div>
      {onMove && (
        <div style={{display:"flex",justifyContent:"space-between",padding:"3px 5px",borderTop:"1px solid #0F172A"}} onClick={e=>e.stopPropagation()}>
          <button style={S.navBtn} disabled={stageIdx===0} onClick={()=>onMove(-1)}>◀</button>
          <button style={S.navBtn} disabled={stageIdx===totalStages-1} onClick={()=>onMove(1)}>▶</button>
        </div>
      )}
    </div>
  );
}
function Modal({title,children,onClose,wide}) {
  return (
    <div style={S.overlay} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div style={{...S.modal,...(wide?{maxWidth:860}:{})}}>
        <div style={{padding:"13px 18px",borderBottom:"1px solid #334155",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div style={{fontWeight:700,fontSize:"1rem",color:"#F1F5F9"}}>{title}</div>
          <button style={{background:"transparent",border:"none",color:"#64748B",cursor:"pointer",fontSize:"1rem",fontFamily:"inherit"}} onClick={onClose}>✕</button>
        </div>
        <div style={{padding:18,overflowY:"auto",flex:1,maxHeight:"80vh"}}>{children}</div>
      </div>
    </div>
  );
}
function Section({title,children}) {
  return <div style={{display:"flex",flexDirection:"column",gap:8}}>
    <div style={{fontSize:".68rem",letterSpacing:".1em",textTransform:"uppercase",color:"#475569",fontWeight:700,borderBottom:"1px solid #1E293B",paddingBottom:4,marginBottom:2}}>{title}</div>
    {children}
  </div>;
}
function Stat({label,value,color}) {
  return <div style={{textAlign:"center"}}>
    <div style={{fontSize:"1.2rem",fontWeight:700,color:color||"#E2E8F0"}}>{value}</div>
    <div style={{fontSize:".58rem",color:"#64748B",letterSpacing:".06em",textTransform:"uppercase"}}>{label}</div>
  </div>;
}
function InfoRow({label,value,highlight}) {
  return <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"3px 0"}}>
    <span style={{fontSize:".72rem",color:"#64748B"}}>{label}</span>
    <span style={{fontSize:".82rem",fontWeight:600,color:highlight?"#FCD34D":"#E2E8F0"}}>{value}</span>
  </div>;
}

function blankVehicle() { return {year:"",make:"",model:"",vin:"",stock:"",stage:"intake"}; }
function partStatusColor(s) { return {ordered:"#7C3AED",received:"#2563EB",installed:"#059669",pending:"#D97706"}[s]||"#4B5563"; }
function jobStatusColor(s)  { return {pending:"#D97706",in_progress:"#2563EB",completed:"#059669",cancelled:"#6B7280"}[s]||"#4B5563"; }
function jobStatusLabel(s)  { return {pending:"Pending",in_progress:"In Progress",completed:"Completed",cancelled:"Cancelled"}[s]||s; }
function roleBadgeStyle(r)  { return {display:"inline-block",padding:"2px 9px",borderRadius:5,fontSize:".68rem",fontWeight:700,color:"#fff",background:{admin:"#DC2626",manager:"#D97706",tech:"#2563EB",viewer:"#475569"}[r]||"#475569",whiteSpace:"nowrap"}; }

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = {
  root:        { minHeight:"100vh", background:"#0F172A", color:"#E2E8F0", fontFamily:"'DM Mono','Fira Mono','Courier New',monospace", display:"flex", flexDirection:"column" },
  splash:      { display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", background:"#0F172A" },
  splashInner: { textAlign:"center", color:"#94A3B8", fontFamily:"monospace" },
  loginWrap:   { display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", background:"#0F172A" },
  loginBox:    { background:"#1E293B", border:"1px solid #334155", borderRadius:12, padding:"36px 32px", width:340, display:"flex", flexDirection:"column", alignItems:"center", gap:12 },
  loginTitle:  { fontSize:"1.2rem", fontWeight:700, letterSpacing:".1em", color:"#F1F5F9" },
  loginSub:    { fontSize:".72rem", color:"#64748B", letterSpacing:".06em", textTransform:"uppercase" },
  loginInput:  { background:"#0F172A", border:"1px solid #334155", color:"#E2E8F0", padding:"9px 12px", borderRadius:6, fontFamily:"inherit", fontSize:".88rem", outline:"none", width:"100%", boxSizing:"border-box" },
  loginBtn:    { background:"#2563EB", color:"#fff", border:"none", padding:"9px 0", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:".9rem", fontWeight:600, width:"100%", marginTop:4 },
  header:      { background:"#1E293B", borderBottom:"1px solid #334155", padding:"12px 20px", display:"flex", alignItems:"center", gap:16, flexWrap:"wrap" },
  logoTitle:   { fontSize:"1rem", fontWeight:700, letterSpacing:".1em", color:"#F1F5F9" },
  logoSub:     { fontSize:".6rem", color:"#64748B", letterSpacing:".08em", textTransform:"uppercase" },
  headerStats: { display:"flex", gap:18, flex:1, justifyContent:"center", flexWrap:"wrap" },
  navTab:      { background:"transparent", border:"1px solid #334155", color:"#64748B", padding:"5px 11px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:".72rem", letterSpacing:".04em" },
  navTabActive:{ background:"#334155", color:"#E2E8F0", borderColor:"#475569" },
  userChip:    { display:"flex", alignItems:"center", gap:8, background:"#0F172A", border:"1px solid #334155", borderRadius:20, padding:"5px 10px 5px 5px" },
  avatar:      { width:26, height:26, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:".65rem", fontWeight:700, color:"#fff", flexShrink:0 },
  addBtn:      { background:"#2563EB", color:"#fff", border:"none", padding:"7px 16px", borderRadius:6, cursor:"pointer", fontFamily:"inherit", fontSize:".82rem", fontWeight:600, whiteSpace:"nowrap" },
  toolbar:     { padding:"9px 20px", background:"#1E293B", borderBottom:"1px solid #0F172A", display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" },
  search:      { background:"#0F172A", border:"1px solid #334155", color:"#E2E8F0", padding:"5px 10px", borderRadius:5, fontFamily:"inherit", fontSize:".78rem", width:220, outline:"none" },
  filterBtn:   { background:"transparent", border:"1px solid #334155", color:"#94A3B8", padding:"3px 9px", borderRadius:4, cursor:"pointer", fontFamily:"inherit", fontSize:".68rem", letterSpacing:".04em", display:"flex", alignItems:"center", gap:4 },
  filterActive:{ background:"#334155", color:"#E2E8F0", borderColor:"#475569" },
  filterCount: { fontSize:".62rem", borderRadius:10, padding:"1px 5px", color:"#fff", fontWeight:700 },
  board:       { flex:1, display:"grid", gridTemplateColumns:"repeat(7, minmax(155px, 1fr))", overflowX:"auto", borderTop:"1px solid #1E293B" },
  col:         { borderRight:"1px solid #1E293B", display:"flex", flexDirection:"column", minHeight:"calc(100vh - 120px)" },
  colHead:     { padding:"9px 11px", borderBottom:"2px solid", display:"flex", alignItems:"center", justifyContent:"space-between", background:"#131C2E", position:"sticky", top:0, zIndex:2 },
  colCount:    { fontSize:".62rem", borderRadius:10, padding:"2px 6px", color:"#fff", fontWeight:700 },
  colBody:     { flex:1, padding:"9px 7px", display:"flex", flexDirection:"column", gap:7 },
  emptyCol:    { color:"#334155", textAlign:"center", fontSize:"1.3rem", marginTop:18 },
  card:        { background:"#1E293B", border:"1px solid #2D3F58", borderRadius:7, cursor:"pointer", overflow:"hidden", display:"flex", flexDirection:"column" },
  badge:       { fontSize:".6rem", background:"#0F172A", padding:"2px 5px", borderRadius:4, color:"#94A3B8" },
  navBtn:      { background:"transparent", border:"none", color:"#475569", cursor:"pointer", fontSize:".78rem", padding:"2px 5px", fontFamily:"inherit" },
  overlay:     { position:"fixed", inset:0, background:"rgba(0,0,0,.75)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:100, padding:16 },
  modal:       { background:"#1E293B", border:"1px solid #334155", borderRadius:10, width:"100%", maxWidth:480, display:"flex", flexDirection:"column", overflow:"hidden" },
  tabBar:      { display:"flex", borderBottom:"1px solid #334155", padding:"0 18px", overflowX:"auto" },
  tabBtn:      { background:"transparent", border:"none", borderBottom:"2px solid transparent", color:"#64748B", padding:"10px 14px", cursor:"pointer", fontFamily:"inherit", fontSize:".75rem", whiteSpace:"nowrap", display:"flex", alignItems:"center", gap:5 },
  tabBtnActive:{ color:"#E2E8F0", borderBottomColor:"#2563EB" },
  tabBadge:    { background:"#334155", color:"#94A3B8", fontSize:".6rem", borderRadius:8, padding:"1px 5px" },
  formGrid:    { display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px 14px" },
  formField:   { display:"flex", flexDirection:"column", gap:4 },
  formLabel:   { fontSize:".68rem", color:"#64748B", letterSpacing:".06em", textTransform:"uppercase" },
  formInput:   { background:"#0F172A", border:"1px solid #334155", color:"#E2E8F0", padding:"7px 9px", borderRadius:5, fontFamily:"inherit", fontSize:".8rem", outline:"none" },
  modalActions:{ display:"flex", gap:10, justifyContent:"flex-end", marginTop:16 },
  stageBtn:    { border:"1px solid", padding:"5px 10px", borderRadius:5, cursor:"pointer", textAlign:"left", fontFamily:"inherit", fontSize:".75rem", fontWeight:600 },
  partRow:     { display:"flex", alignItems:"center", gap:7, background:"#0F172A", borderRadius:5, padding:"7px 9px", border:"1px solid #1E293B" },
  partInput:   { flex:1, background:"#0F172A", border:"1px solid #334155", color:"#E2E8F0", padding:"5px 8px", borderRadius:5, fontFamily:"inherit", fontSize:".76rem", outline:"none" },
  statusBadge: { color:"#fff", padding:"3px 7px", borderRadius:4, fontSize:".62rem", fontWeight:600, whiteSpace:"nowrap", fontFamily:"inherit" },
  pageWrap:    { flex:1, padding:"24px 28px", overflowY:"auto" },
  pageHeader:  { display:"flex", alignItems:"center", gap:16, flexWrap:"wrap", marginBottom:24 },
  pageTitle:   { fontSize:"1.2rem", fontWeight:700, color:"#F1F5F9" },
  vendorGrid:  { display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))", gap:14 },
  vendorCard:  { background:"#1E293B", border:"1px solid #2D3F58", borderRadius:9, padding:16, cursor:"pointer", display:"flex", flexDirection:"column", gap:8 },
  vendorIcon:  { width:36, height:36, borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:700, fontSize:"1rem", color:"#fff", flexShrink:0 },
  userTable:   { background:"#1E293B", border:"1px solid #334155", borderRadius:9, overflow:"hidden", marginBottom:20 },
  userTableHead:{ display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr", padding:"8px 16px", background:"#131C2E", borderBottom:"1px solid #334155" },
  thCell:      { fontSize:".65rem", color:"#475569", letterSpacing:".08em", textTransform:"uppercase" },
  userRow:     { display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr", padding:"10px 16px", borderBottom:"1px solid #1E293B", alignItems:"center" },
  saveBtn:     { background:"#2563EB", color:"#fff", border:"none", padding:"7px 14px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:".78rem", fontWeight:600, whiteSpace:"nowrap" },
  cancelBtn:   { background:"transparent", color:"#94A3B8", border:"1px solid #334155", padding:"7px 13px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:".78rem" },
  deleteBtn:   { background:"#7F1D1D", color:"#FCA5A5", border:"1px solid #991B1B", padding:"7px 13px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:".78rem" },
  deleteSmall: { background:"transparent", border:"none", color:"#475569", cursor:"pointer", fontSize:".73rem", fontFamily:"inherit", padding:"0 3px" },
  emptyText:   { color:"#334155", fontSize:".76rem", fontStyle:"italic" },
  lbBtn:       { background:"#1E293B", border:"1px solid #334155", color:"#94A3B8", padding:"6px 14px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:".78rem" },
};
