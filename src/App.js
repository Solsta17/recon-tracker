import { useState, useEffect, useRef, useCallback } from "react";
import {
  collection, doc, onSnapshot, setDoc, deleteDoc,
  updateDoc, addDoc, serverTimestamp
} from "firebase/firestore";
import {
  ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from "firebase/storage";
import { db, storage } from "./firebase";
import { MAKES, MAKE_MODELS } from "./vehicles";

// ─── Default stages (used if none saved in Firebase) ─────────────────────────
const DEFAULT_STAGES = [
  { id: "intake",    label: "Intake",        color: "#6B7280" },
  { id: "inspect",  label: "Inspection",     color: "#D97706" },
  { id: "parts",    label: "Parts Ordered",  color: "#7C3AED" },
  { id: "service",  label: "In Service",     color: "#2563EB" },
  { id: "detail",   label: "Detail",         color: "#059669" },
  { id: "photos",   label: "Photos",         color: "#DB2777" },
  { id: "frontline",label: "Front Line ✓",   color: "#16A34A" },
];

const STAGE_COLORS = [
  "#6B7280","#D97706","#7C3AED","#2563EB","#059669",
  "#DB2777","#16A34A","#DC2626","#0891B2","#92400E"
];

const ROLES = { admin: "Admin", manager: "Manager", tech: "Technician", viewer: "Viewer" };
const VENDOR_TYPES = ["Body Shop","Detail","Mechanical","Glass","Upholstery","Tires","PDR","Other"];
const FIELD_TYPES = ["text","number","currency"];

function uid()   { return Math.random().toString(36).slice(2,10); }
function fmt$(n) { const v=parseFloat(n); return isNaN(v)?"$0.00":"$"+v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,","); }
function daysAgo(ts) {
  if (!ts) return "—";
  const ms = ts.toMillis ? ts.toMillis() : ts;
  const d = Math.floor((Date.now()-ms)/86400000);
  return d===0?"today":d===1?"1 day":`${d} days`;
}
function initials(name) { return name?name.split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2):"?"; }
function avatarColor(name) {
  const colors=["#7C3AED","#2563EB","#059669","#D97706","#DB2777","#DC2626","#0891B2"];
  let h=0; for(let c of (name||"")) h=(h*31+c.charCodeAt(0))%colors.length;
  return colors[h];
}
function accentOf(color) {
  const map={"#6B7280":"#9CA3AF","#D97706":"#FCD34D","#7C3AED":"#C4B5FD","#2563EB":"#93C5FD",
    "#059669":"#6EE7B7","#DB2777":"#F9A8D4","#16A34A":"#86EFAC","#DC2626":"#FCA5A5",
    "#0891B2":"#67E8F9","#92400E":"#FCD34D"};
  return map[color]||"#E2E8F0";
}

const col = (name) => collection(db, name);

// ─── Combobox Component ───────────────────────────────────────────────────────
function Combobox({ value, onChange, options, placeholder, disabled }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value || "");
  const ref = useRef();

  useEffect(() => { setQuery(value || ""); }, [value]);

  useEffect(() => {
    function handler(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = query.length === 0
    ? options
    : options.filter(o => o.toLowerCase().includes(query.toLowerCase()));

  function select(opt) {
    setQuery(opt);
    onChange(opt);
    setOpen(false);
  }

  function handleChange(e) {
    setQuery(e.target.value);
    onChange(e.target.value);
    setOpen(true);
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <input
        style={S.formInput}
        placeholder={placeholder}
        value={query}
        disabled={disabled}
        onChange={handleChange}
        onFocus={() => setOpen(true)}
        autoComplete="off"
      />
      {open && filtered.length > 0 && (
        <div style={{
          position: "absolute", top: "100%", left: 0, right: 0, zIndex: 200,
          background: "#1E293B", border: "1px solid #334155", borderRadius: 6,
          maxHeight: 200, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,.5)"
        }}>
          {filtered.map(opt => (
            <div key={opt}
              style={{
                padding: "7px 12px", cursor: "pointer", fontSize: ".82rem",
                color: opt === value ? "#93C5FD" : "#E2E8F0",
                background: opt === value ? "#1E3A5F" : "transparent",
              }}
              onMouseDown={() => select(opt)}
              onMouseEnter={e => e.currentTarget.style.background = "#334155"}
              onMouseLeave={e => e.currentTarget.style.background = opt === value ? "#1E3A5F" : "transparent"}
            >
              {opt}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── VIN Scanner Component ────────────────────────────────────────────────────
function VinScanner({ onScanned, onClose }) {
  const videoRef = useRef();
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [manualVin, setManualVin] = useState("");
  const streamRef = useRef();
  const intervalRef = useRef();

  useEffect(() => {
    startCamera();
    return () => stopCamera();
  }, []);

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
        setScanning(true);
        startScanning();
      }
    } catch (e) {
      setError("Camera access denied. Enter VIN manually below.");
    }
  }

  function stopCamera() {
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (intervalRef.current) clearInterval(intervalRef.current);
  }

  function startScanning() {
    // Use ZXing via CDN for barcode detection
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/zxing-js/0.20.0/zxing.min.js";
    script.onload = () => {
      try {
        const hints = new Map();
        hints.set(2, [2, 6, 7, 8, 11, 12, 13, 14]); // multiple barcode formats
        const reader = new window.ZXing.BrowserMultiFormatReader(hints);
        reader.decodeFromVideoDevice(null, videoRef.current, (result, err) => {
          if (result) {
            const text = result.getText().trim().toUpperCase();
            // VINs are 17 alphanumeric chars
            if (/^[A-HJ-NPR-Z0-9]{17}$/.test(text)) {
              reader.reset();
              stopCamera();
              onScanned(text);
            }
          }
        });
      } catch(e) {
        setError("Scanner unavailable. Enter VIN manually.");
      }
    };
    script.onerror = () => setError("Scanner library failed to load. Enter VIN manually.");
    document.head.appendChild(script);
  }

  function submitManual() {
    const v = manualVin.trim().toUpperCase();
    if (v.length !== 17) { setError("VIN must be exactly 17 characters."); return; }
    stopCamera();
    onScanned(v);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: ".8rem", color: "#94A3B8" }}>
        Point camera at the VIN barcode (usually on the dashboard or door jamb).
      </div>
      <div style={{ position: "relative", borderRadius: 8, overflow: "hidden", background: "#000", maxHeight: 240 }}>
        <video ref={videoRef} style={{ width: "100%", display: "block" }} playsInline muted />
        {scanning && (
          <div style={{
            position: "absolute", top: "50%", left: "10%", right: "10%", height: 2,
            background: "#2563EB", transform: "translateY(-50%)", boxShadow: "0 0 8px #2563EB",
            animation: "scan 1.5s ease-in-out infinite alternate"
          }}/>
        )}
        <style>{`@keyframes scan{from{top:30%}to{top:70%}}`}</style>
      </div>
      {error && <div style={{ color: "#F87171", fontSize: ".78rem" }}>{error}</div>}
      <div style={{ borderTop: "1px solid #334155", paddingTop: 12 }}>
        <div style={{ fontSize: ".72rem", color: "#64748B", marginBottom: 8 }}>Or enter VIN manually:</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ ...S.formInput, flex: 1, textTransform: "uppercase" }}
            placeholder="17-character VIN"
            maxLength={17}
            value={manualVin}
            onChange={e => setManualVin(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === "Enter" && submitManual()}
          />
          <button style={S.saveBtn} onClick={submitManual}>Use VIN</button>
        </div>
      </div>
      <div style={S.modalActions}>
        <button style={S.cancelBtn} onClick={() => { stopCamera(); onClose(); }}>Cancel</button>
      </div>
    </div>
  );
}

export default function ReconTracker() {
  const [vehicles,    setVehicles]    = useState([]);
  const [parts,       setParts]       = useState([]);
  const [notes,       setNotes]       = useState([]);
  const [photos,      setPhotos]      = useState([]);
  const [users,       setUsers]       = useState([]);
  const [vendors,     setVendors]     = useState([]);
  const [vendorJobs,  setVendorJobs]  = useState([]);
  const [settings,    setSettings]    = useState(null); // { stages, customFields }
  const [loaded,      setLoaded]      = useState(false);

  // Auth
  const [currentUser, setCurrentUser] = useState(null);
  const [loginName,   setLoginName]   = useState("");
  const [loginPin,    setLoginPin]    = useState("");
  const [loginError,  setLoginError]  = useState("");

  // UI
  const [view,            setView]            = useState("board");
  const [detailVehicleId, setDetailVehicleId] = useState(null);
  const [detailTab,       setDetailTab]       = useState("info");
  const [editingVehicle,  setEditingVehicle]  = useState(null);
  const [editingUser,     setEditingUser]     = useState(null);
  const [editingVendor,   setEditingVendor]   = useState(null);
  const [editingPart,     setEditingPart]     = useState(null);
  const [editingJob,      setEditingJob]      = useState(null);
  const [addingVehicle,   setAddingVehicle]   = useState(false);
  const [newV,            setNewV]            = useState(blankVehicle());
  const [noteInput,       setNoteInput]       = useState("");
  const [newPart,         setNewPart]         = useState({name:"",cost:"",status:"ordered",vendorId:""});
  const [stageFilter,     setStageFilter]     = useState(null);
  const [searchQ,         setSearchQ]         = useState("");
  const [confirmDelete,   setConfirmDelete]   = useState(null);
  const [photoCaption,    setPhotoCaption]    = useState("");
  const [uploading,       setUploading]       = useState(false);
  const [lightbox,        setLightbox]        = useState(null);
  const [addingUser,      setAddingUser]      = useState(false);
  const [newUser,         setNewUser]         = useState({name:"",pin:"",role:"tech"});
  const [addingVendor,    setAddingVendor]    = useState(false);
  const [newVendor,       setNewVendor]       = useState({name:"",type:"Mechanical",phone:"",contact:"",notes:""});
  const [vendorDetail,    setVendorDetail]    = useState(null);
  const [addingJob,       setAddingJob]       = useState(false);
  const [newJob,          setNewJob]          = useState({vendorId:"",description:"",cost:"",status:"pending"});
  const [showVinScanner,  setShowVinScanner]  = useState(false);
  const [vinScanTarget,   setVinScanTarget]   = useState(null); // "new" | "edit"
  const fileInputRef = useRef();

  // Settings panel state
  const [editingStages,      setEditingStages]      = useState(false);
  const [editingFields,      setEditingFields]      = useState(false);
  const [draftStages,        setDraftStages]        = useState([]);
  const [draftFields,        setDraftFields]        = useState([]);
  const [newStageName,       setNewStageName]       = useState("");
  const [newStageColor,      setNewStageColor]      = useState("#2563EB");
  const [newFieldName,       setNewFieldName]       = useState("");
  const [newFieldType,       setNewFieldType]       = useState("text");

  // ── Listeners ──
  useEffect(() => {
    const unsubs = [
      onSnapshot(col("users"),      s => { setUsers(s.docs.map(d=>({id:d.id,...d.data()}))); setLoaded(true); }),
      onSnapshot(col("vehicles"),   s => { setVehicles(s.docs.map(d=>({id:d.id,...d.data()}))); }),
      onSnapshot(col("parts"),      s => { setParts(s.docs.map(d=>({id:d.id,...d.data()}))); }),
      onSnapshot(col("notes"),      s => { setNotes(s.docs.map(d=>({id:d.id,...d.data()}))); }),
      onSnapshot(col("photos"),     s => { setPhotos(s.docs.map(d=>({id:d.id,...d.data()}))); }),
      onSnapshot(col("vendors"),    s => { setVendors(s.docs.map(d=>({id:d.id,...d.data()}))); }),
      onSnapshot(col("vendorJobs"), s => { setVendorJobs(s.docs.map(d=>({id:d.id,...d.data()}))); }),
      onSnapshot(doc(db,"settings","config"), d => { setSettings(d.exists()?d.data():null); }),
    ];
    return () => unsubs.forEach(u=>u());
  }, []);

  useEffect(() => {
    if (loaded && users.length===0) {
      setDoc(doc(db,"users","u_admin"),{name:"Admin",pin:"1234",role:"admin",createdAt:serverTimestamp()});
    }
  }, [loaded, users.length]);

  // ── Derived ──
  const stages = settings?.stages || DEFAULT_STAGES;
  const customFields = settings?.customFields || [];
  const stageIds = stages.map(s=>s.id);
  const detail     = vehicles.find(v=>v.id===detailVehicleId);
  const vParts     = (id) => parts.filter(p=>p.vehicleId===id);
  const vNotes     = (id) => notes.filter(n=>n.vehicleId===id).sort((a,b)=>(a.ts?.seconds||0)-(b.ts?.seconds||0));
  const vPhotos    = (id) => photos.filter(p=>p.vehicleId===id).sort((a,b)=>(a.ts?.seconds||0)-(b.ts?.seconds||0));
  const vCost      = (id) => parts.filter(p=>p.vehicleId===id).reduce((a,p)=>a+(parseFloat(p.cost)||0),0);
  const vJobs      = (id) => vendorJobs.filter(j=>j.vehicleId===id);
  const vendorById = (id) => vendors.find(v=>v.id===id);
  const userById   = (id) => users.find(u=>u.id===id);
  const canEdit    = currentUser && ["admin","manager","tech"].includes(currentUser.role);
  const isAdmin    = currentUser?.role==="admin";

  const filtered = vehicles.filter(v => {
    const q = searchQ.toLowerCase();
    const mQ = !q || `${v.year} ${v.make} ${v.model} ${v.vin} ${v.stock}`.toLowerCase().includes(q);
    const mS = !stageFilter || v.stage===stageFilter;
    return mQ && mS;
  });
  const stageCounts = stages.reduce((a,s)=>{ a[s.id]=vehicles.filter(v=>v.stage===s.id).length; return a; },{});
  const totalCost   = parts.reduce((a,p)=>a+(parseFloat(p.cost)||0),0);

  // ── Auth ──
  function handleLogin() {
    const u = users.find(u=>u.name.toLowerCase()===loginName.toLowerCase()&&u.pin===loginPin);
    if (u) { setCurrentUser(u); setLoginError(""); setLoginPin(""); }
    else setLoginError("Name or PIN not found.");
  }

  // ── Vehicles ──
  async function addVehicle() {
    if (!newV.make&&!newV.model) return;
    await addDoc(col("vehicles"),{...newV,addedAt:serverTimestamp(),addedBy:currentUser.id});
    setNewV(blankVehicle()); setAddingVehicle(false);
  }
  async function saveEditVehicle() {
    if (!editingVehicle) return;
    const {id,...data} = editingVehicle;
    await updateDoc(doc(db,"vehicles",id),data);
    setEditingVehicle(null);
  }
  async function moveStage(id,dir) {
    const v=vehicles.find(v=>v.id===id); if(!v) return;
    const i=stageIds.indexOf(v.stage);
    await updateDoc(doc(db,"vehicles",id),{stage:stageIds[Math.min(Math.max(i+dir,0),stageIds.length-1)]});
  }
  async function setStage(id,stage) { await updateDoc(doc(db,"vehicles",id),{stage}); }
  async function deleteVehicle(id) {
    await deleteDoc(doc(db,"vehicles",id));
    parts.filter(p=>p.vehicleId===id).forEach(p=>deleteDoc(doc(db,"parts",p.id)));
    notes.filter(n=>n.vehicleId===id).forEach(n=>deleteDoc(doc(db,"notes",n.id)));
    vendorJobs.filter(j=>j.vehicleId===id).forEach(j=>deleteDoc(doc(db,"vendorJobs",j.id)));
    photos.filter(ph=>ph.vehicleId===id).forEach(ph=>{
      if(ph.storagePath) deleteObject(storageRef(storage,ph.storagePath)).catch(()=>{});
      deleteDoc(doc(db,"photos",ph.id));
    });
    setDetailVehicleId(null); setConfirmDelete(null);
  }

  // ── Notes ──
  async function addNote() {
    if (!noteInput.trim()||!detail) return;
    await addDoc(col("notes"),{vehicleId:detail.id,text:noteInput.trim(),ts:serverTimestamp(),userId:currentUser.id});
    setNoteInput("");
  }
  async function deleteNote(id) { await deleteDoc(doc(db,"notes",id)); }

  // ── Parts ──
  async function addPart() {
    if (!newPart.name.trim()||!detail) return;
    await addDoc(col("parts"),{...newPart,vehicleId:detail.id,addedBy:currentUser.id,ts:serverTimestamp()});
    setNewPart({name:"",cost:"",status:"ordered",vendorId:""});
  }
  async function saveEditPart() {
    if (!editingPart) return;
    const {id,...data}=editingPart;
    await updateDoc(doc(db,"parts",id),data);
    setEditingPart(null);
  }
  async function deletePart(id) { await deleteDoc(doc(db,"parts",id)); }
  async function updatePartStatus(id,status) { await updateDoc(doc(db,"parts",id),{status}); }

  // ── Photos ──
  async function handlePhotoUpload(e) {
    if (!detail) return;
    const files=Array.from(e.target.files);
    setUploading(true);
    for (const file of files) {
      try {
        const path=`photos/${detail.id}/${uid()}_${file.name}`;
        const sRef=storageRef(storage,path);
        await uploadBytes(sRef,file);
        const url=await getDownloadURL(sRef);
        await addDoc(col("photos"),{vehicleId:detail.id,url,storagePath:path,caption:photoCaption||file.name,uploadedBy:currentUser.id,ts:serverTimestamp()});
      } catch(err){ console.error("Upload failed:",err); }
    }
    setUploading(false); setPhotoCaption(""); e.target.value="";
  }
  async function deletePhoto(photo) {
    if (photo.storagePath) { try{ await deleteObject(storageRef(storage,photo.storagePath)); }catch{} }
    await deleteDoc(doc(db,"photos",photo.id));
  }

  // ── Users ──
  async function addUser() {
    if (!newUser.name.trim()||!newUser.pin.trim()) return;
    await setDoc(doc(db,"users",uid()),{...newUser,createdAt:serverTimestamp()});
    setNewUser({name:"",pin:"",role:"tech"}); setAddingUser(false);
  }
  async function saveEditUser() {
    if (!editingUser) return;
    const {id,...data}=editingUser;
    await updateDoc(doc(db,"users",id),data);
    setEditingUser(null);
  }
  async function deleteUser(id) {
    if (id===currentUser.id) return;
    await deleteDoc(doc(db,"users",id));
  }

  // ── Vendors ──
  async function addVendor() {
    if (!newVendor.name.trim()) return;
    await addDoc(col("vendors"),{...newVendor,createdAt:serverTimestamp()});
    setNewVendor({name:"",type:"Mechanical",phone:"",contact:"",notes:""}); setAddingVendor(false);
  }
  async function saveEditVendor() {
    if (!editingVendor) return;
    const {id,...data}=editingVendor;
    await updateDoc(doc(db,"vendors",id),data);
    setEditingVendor(null);
  }
  async function deleteVendor(id) {
    await deleteDoc(doc(db,"vendors",id));
    vendorJobs.filter(j=>j.vendorId===id).forEach(j=>deleteDoc(doc(db,"vendorJobs",j.id)));
  }

  // ── Vendor Jobs ──
  async function addVendorJob() {
    if (!newJob.vendorId||!newJob.description.trim()||!detail) return;
    await addDoc(col("vendorJobs"),{...newJob,vehicleId:detail.id,addedBy:currentUser.id,createdAt:serverTimestamp()});
    setNewJob({vendorId:"",description:"",cost:"",status:"pending"}); setAddingJob(false);
  }
  async function saveEditJob() {
    if (!editingJob) return;
    const {id,...data}=editingJob;
    await updateDoc(doc(db,"vendorJobs",id),data);
    setEditingJob(null);
  }
  async function updateJobStatus(id,status) { await updateDoc(doc(db,"vendorJobs",id),{status}); }
  async function deleteJob(id) { await deleteDoc(doc(db,"vendorJobs",id)); }

  // ── Settings: Stages ──
  function openStageEditor() {
    setDraftStages(stages.map(s=>({...s})));
    setEditingStages(true);
  }
  function addDraftStage() {
    if (!newStageName.trim()) return;
    setDraftStages(p=>[...p,{id:uid(),label:newStageName.trim(),color:newStageColor}]);
    setNewStageName(""); setNewStageColor("#2563EB");
  }
  function removeDraftStage(id) { setDraftStages(p=>p.filter(s=>s.id!==id)); }
  function moveDraftStage(idx,dir) {
    setDraftStages(p=>{
      const a=[...p]; const b=a[idx+dir]; a[idx+dir]=a[idx]; a[idx]=b; return a;
    });
  }
  async function saveStages() {
    await setDoc(doc(db,"settings","config"),{
      stages: draftStages,
      customFields: settings?.customFields||[]
    });
    setEditingStages(false);
  }

  // ── Settings: Custom Fields ──
  function openFieldEditor() {
    setDraftFields((settings?.customFields||[]).map(f=>({...f})));
    setEditingFields(true);
  }
  function addDraftField() {
    if (!newFieldName.trim()) return;
    setDraftFields(p=>[...p,{id:uid(),label:newFieldName.trim(),type:newFieldType}]);
    setNewFieldName(""); setNewFieldType("text");
  }
  function removeDraftField(id) { setDraftFields(p=>p.filter(f=>f.id!==id)); }
  async function saveFields() {
    await setDoc(doc(db,"settings","config"),{
      stages: settings?.stages||DEFAULT_STAGES,
      customFields: draftFields
    });
    setEditingFields(false);
  }

  // ── Screens ──
  if (!loaded) return (
    <div style={S.loginWrap}>
      <div style={S.loginBox}>
        <div style={{fontSize:"2.5rem"}}>🔧</div>
        <div style={S.loginTitle}>RECON TRACKER</div>
        <div style={{color:"#475569",fontSize:".75rem",marginTop:4,display:"flex",alignItems:"center",gap:8}}>
          <span style={{display:"inline-block",width:12,height:12,borderRadius:"50%",border:"2px solid #2563EB",borderTopColor:"transparent",animation:"spin 0.8s linear infinite"}}/>
          Connecting…
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
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
          <input style={S.loginInput} placeholder="Your name" value={loginName} onChange={e=>setLoginName(e.target.value)}/>
          <input style={S.loginInput} placeholder="PIN" type="password" maxLength={8} value={loginPin}
            onChange={e=>setLoginPin(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleLogin()}/>
        </div>
        {loginError&&<div style={{color:"#F87171",fontSize:".78rem"}}>{loginError}</div>}
        <button style={S.loginBtn} onClick={handleLogin}>Sign In</button>
      </div>
    </div>
  );

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
          <Stat label="Vehicles"    value={vehicles.length}/>
          <Stat label="In Pipeline" value={vehicles.filter(v=>v.stage!==stages[stages.length-1]?.id).length}/>
          <Stat label="Front Line"  value={vehicles.filter(v=>v.stage===stages[stages.length-1]?.id).length} color="#86EFAC"/>
          <Stat label="Parts Cost"  value={fmt$(totalCost)} color="#FCD34D"/>
          <Stat label="Vendors"     value={vendors.length} color="#C4B5FD"/>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <div style={{display:"flex",gap:4}}>
            {[["board","📋 Board"],["vendors","🏢 Vendors"],...(isAdmin?[["users","👥 Users"],["settings","⚙️ Settings"]]:[])].map(([v,l])=>(
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
          {canEdit&&view==="board"&&<button style={S.addBtn} onClick={()=>setAddingVehicle(true)}>+ Vehicle</button>}
        </div>
      </header>

      {/* ══ BOARD ══ */}
      {view==="board"&&(<>
        <div style={S.toolbar}>
          <input style={S.search} placeholder="Search VIN, stock#, make, model…" value={searchQ} onChange={e=>setSearchQ(e.target.value)}/>
          <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
            <button style={{...S.filterBtn,...(!stageFilter?S.filterActive:{})}} onClick={()=>setStageFilter(null)}>All</button>
            {stages.map(s=>(
              <button key={s.id} style={{...S.filterBtn,...(stageFilter===s.id?{background:s.color,color:"#fff",borderColor:s.color}:{})}}
                onClick={()=>setStageFilter(stageFilter===s.id?null:s.id)}>
                {s.label}
                {stageCounts[s.id]>0&&<span style={{...S.filterCount,background:stageFilter===s.id?"rgba(255,255,255,.25)":s.color}}>{stageCounts[s.id]}</span>}
              </button>
            ))}
          </div>
        </div>
        <div style={{...S.board,gridTemplateColumns:`repeat(${stages.length}, minmax(155px, 1fr))`}}>
          {stages.map(stage=>{
            const svs=filtered.filter(v=>v.stage===stage.id);
            return (
              <div key={stage.id} style={S.col}>
                <div style={{...S.colHead,borderColor:stage.color}}>
                  <span style={{color:accentOf(stage.color),fontWeight:700,fontSize:".73rem",letterSpacing:".08em",textTransform:"uppercase"}}>{stage.label}</span>
                  <span style={{...S.colCount,background:stage.color}}>{svs.length}</span>
                </div>
                <div style={S.colBody}>
                  {svs.length===0&&<div style={S.emptyCol}>—</div>}
                  {svs.map(v=>(
                    <VehicleCard key={v.id} vehicle={v} stage={stage}
                      cost={vCost(v.id)} partCount={vParts(v.id).length}
                      noteCount={vNotes(v.id).length} photoCount={vPhotos(v.id).length}
                      jobCount={vJobs(v.id).length}
                      onOpen={()=>{setDetailVehicleId(v.id);setDetailTab("info");}}
                      onMove={canEdit?(dir=>moveStage(v.id,dir)):null}
                      stageIdx={stageIds.indexOf(v.stage)} totalStages={stages.length}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </>)}

      {/* ══ VENDORS ══ */}
      {view==="vendors"&&(
        <div style={S.pageWrap}>
          <div style={S.pageHeader}>
            <div style={S.pageTitle}>🏢 Vendor Directory</div>
            <div style={{fontSize:".78rem",color:"#64748B",flex:1}}>Shops and contractors you send vehicles to</div>
            {canEdit&&<button style={S.addBtn} onClick={()=>setAddingVendor(true)}>+ Add Vendor</button>}
          </div>
          {vendors.length===0&&(
            <div style={{textAlign:"center",paddingTop:60}}>
              <div style={{fontSize:"3rem",marginBottom:12}}>🏢</div>
              <div style={{color:"#94A3B8",fontSize:".9rem"}}>No vendors yet.</div>
            </div>
          )}
          <div style={S.vendorGrid}>
            {vendors.map(v=>{
              const jobs=vendorJobs.filter(j=>j.vendorId===v.id);
              const spend=jobs.reduce((a,j)=>a+(parseFloat(j.cost)||0),0);
              return (
                <div key={v.id} style={S.vendorCard}>
                  <div style={{display:"flex",gap:12,alignItems:"center"}}>
                    <div style={{...S.vendorIcon,background:avatarColor(v.name)}}>{v.name[0].toUpperCase()}</div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:".88rem",fontWeight:700,color:"#F1F5F9"}}>{v.name}</div>
                      <div style={{fontSize:".68rem",color:"#7C3AED",textTransform:"uppercase",letterSpacing:".04em"}}>{v.type}</div>
                    </div>
                    {canEdit&&(
                      <div style={{display:"flex",gap:4}}>
                        <button style={S.editSmall} onClick={()=>setEditingVendor({...v})}>✏️</button>
                        <button style={S.deleteSmall} onClick={()=>deleteVendor(v.id)}>🗑</button>
                      </div>
                    )}
                  </div>
                  {v.contact&&<div style={{fontSize:".72rem",color:"#64748B"}}>👤 {v.contact}</div>}
                  {v.phone&&<div style={{fontSize:".72rem",color:"#64748B"}}>📞 {v.phone}</div>}
                  <div style={{display:"flex",gap:14,borderTop:"1px solid #1E293B",paddingTop:8,marginTop:2}}>
                    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
                      <span style={{color:"#FCD34D",fontWeight:700}}>{fmt$(spend)}</span>
                      <span style={{fontSize:".6rem",color:"#475569",textTransform:"uppercase"}}>spent</span>
                    </div>
                    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
                      <span style={{color:"#93C5FD",fontWeight:700}}>{jobs.length}</span>
                      <span style={{fontSize:".6rem",color:"#475569",textTransform:"uppercase"}}>jobs</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ══ USERS ══ */}
      {view==="users"&&isAdmin&&(
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
                  {u.id===currentUser.id&&<span style={{background:"#1E3A5F",color:"#93C5FD",fontSize:".6rem",padding:"1px 7px",borderRadius:8,fontWeight:600}}>you</span>}
                </div>
                <div style={roleBadgeStyle(u.role)}>{ROLES[u.role]}</div>
                <div style={{fontSize:".78rem",color:"#475569",fontFamily:"monospace"}}>{"•".repeat((u.pin||"").length)}</div>
                <div style={{display:"flex",gap:6}}>
                  <button style={S.editSmall} onClick={()=>setEditingUser({...u})}>✏️</button>
                  {u.id!==currentUser.id&&<button style={S.deleteSmall} onClick={()=>deleteUser(u.id)}>🗑</button>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══ SETTINGS ══ */}
      {view==="settings"&&isAdmin&&(
        <div style={S.pageWrap}>
          <div style={S.pageHeader}>
            <div style={S.pageTitle}>⚙️ Settings</div>
          </div>

          {/* Stages */}
          <div style={S.settingsCard}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div>
                <div style={{fontSize:".9rem",fontWeight:700,color:"#F1F5F9"}}>Pipeline Stages</div>
                <div style={{fontSize:".72rem",color:"#64748B",marginTop:2}}>Rename, add, remove or reorder recon stages</div>
              </div>
              <button style={S.addBtn} onClick={openStageEditor}>Edit Stages</button>
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
              {stages.map((s,i)=>(
                <div key={s.id} style={{background:s.color,color:"#fff",padding:"4px 12px",borderRadius:5,fontSize:".78rem",fontWeight:600}}>
                  {i+1}. {s.label}
                </div>
              ))}
            </div>
          </div>

          {/* Custom Fields */}
          <div style={{...S.settingsCard,marginTop:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div>
                <div style={{fontSize:".9rem",fontWeight:700,color:"#F1F5F9"}}>Custom Vehicle Fields</div>
                <div style={{fontSize:".72rem",color:"#64748B",marginTop:2}}>Add extra fields to every vehicle (Color, Mileage, Price, etc.)</div>
              </div>
              <button style={S.addBtn} onClick={openFieldEditor}>Edit Fields</button>
            </div>
            {customFields.length===0&&<div style={S.emptyText}>No custom fields yet.</div>}
            <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
              {customFields.map(f=>(
                <div key={f.id} style={{background:"#0F172A",border:"1px solid #334155",color:"#94A3B8",padding:"4px 12px",borderRadius:5,fontSize:".78rem"}}>
                  {f.label} <span style={{color:"#475569",fontSize:".65rem"}}>({f.type})</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ══ ADD VEHICLE ══ */}
      {addingVehicle&&(
        <Modal title="Add Vehicle" onClose={()=>setAddingVehicle(false)}>
          {showVinScanner&&vinScanTarget==="new"?(
            <VinScanner
              onScanned={vin=>{ setNewV(p=>({...p,vin})); setShowVinScanner(false); setVinScanTarget(null); }}
              onClose={()=>{ setShowVinScanner(false); setVinScanTarget(null); }}
            />
          ):(
            <>
              <div style={S.formGrid}>
                <div style={S.formField}>
                  <label style={S.formLabel}>Year</label>
                  <input style={S.formInput} placeholder="e.g. 2021" value={newV.year||""} onChange={e=>setNewV(p=>({...p,year:e.target.value}))}/>
                </div>
                <div style={S.formField}>
                  <label style={S.formLabel}>Make</label>
                  <Combobox
                    value={newV.make||""}
                    onChange={v=>setNewV(p=>({...p,make:v,model:""}))}
                    options={MAKES}
                    placeholder="e.g. Chevrolet"
                  />
                </div>
                <div style={S.formField}>
                  <label style={S.formLabel}>Model</label>
                  <Combobox
                    value={newV.model||""}
                    onChange={v=>setNewV(p=>({...p,model:v}))}
                    options={MAKE_MODELS[newV.make]||[]}
                    placeholder={newV.make?"Select model…":"Select make first"}
                    disabled={!newV.make}
                  />
                </div>
                <div style={S.formField}>
                  <label style={S.formLabel}>VIN</label>
                  <div style={{display:"flex",gap:6}}>
                    <input style={{...S.formInput,flex:1,textTransform:"uppercase"}} placeholder="17-char VIN"
                      value={newV.vin||""} onChange={e=>setNewV(p=>({...p,vin:e.target.value.toUpperCase()}))}/>
                    <button style={{...S.saveBtn,padding:"7px 10px",fontSize:".75rem"}}
                      onClick={()=>{ setShowVinScanner(true); setVinScanTarget("new"); }}
                      title="Scan VIN barcode">📷</button>
                  </div>
                </div>
                <div style={S.formField}>
                  <label style={S.formLabel}>Stock #</label>
                  <input style={S.formInput} placeholder="e.g. U1234" value={newV.stock||""} onChange={e=>setNewV(p=>({...p,stock:e.target.value}))}/>
                </div>
                {customFields.map(f=>(
                  <div key={f.id} style={S.formField}>
                    <label style={S.formLabel}>{f.label}</label>
                    <input style={S.formInput} type={f.type==="number"||f.type==="currency"?"number":"text"}
                      value={newV[f.id]||""} onChange={e=>setNewV(p=>({...p,[f.id]:e.target.value}))}/>
                  </div>
                ))}
                <div style={S.formField}>
                  <label style={S.formLabel}>Starting Stage</label>
                  <select style={S.formInput} value={newV.stage} onChange={e=>setNewV(p=>({...p,stage:e.target.value}))}>
                    {stages.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}
                  </select>
                </div>
              </div>
              <div style={S.modalActions}>
                <button style={S.cancelBtn} onClick={()=>setAddingVehicle(false)}>Cancel</button>
                <button style={S.saveBtn} onClick={addVehicle}>Add Vehicle</button>
              </div>
            </>
          )}
        </Modal>
      )}

      {/* ══ EDIT VEHICLE ══ */}
      {editingVehicle&&(
        <Modal title="Edit Vehicle" onClose={()=>setEditingVehicle(null)}>
          {showVinScanner&&vinScanTarget==="edit"?(
            <VinScanner
              onScanned={vin=>{ setEditingVehicle(p=>({...p,vin})); setShowVinScanner(false); setVinScanTarget(null); }}
              onClose={()=>{ setShowVinScanner(false); setVinScanTarget(null); }}
            />
          ):(
            <>
              <div style={S.formGrid}>
                <div style={S.formField}>
                  <label style={S.formLabel}>Year</label>
                  <input style={S.formInput} value={editingVehicle.year||""} onChange={e=>setEditingVehicle(p=>({...p,year:e.target.value}))}/>
                </div>
                <div style={S.formField}>
                  <label style={S.formLabel}>Make</label>
                  <Combobox
                    value={editingVehicle.make||""}
                    onChange={v=>setEditingVehicle(p=>({...p,make:v,model:""}))}
                    options={MAKES}
                    placeholder="e.g. Chevrolet"
                  />
                </div>
                <div style={S.formField}>
                  <label style={S.formLabel}>Model</label>
                  <Combobox
                    value={editingVehicle.model||""}
                    onChange={v=>setEditingVehicle(p=>({...p,model:v}))}
                    options={MAKE_MODELS[editingVehicle.make]||[]}
                    placeholder={editingVehicle.make?"Select model…":"Select make first"}
                    disabled={!editingVehicle.make}
                  />
                </div>
                <div style={S.formField}>
                  <label style={S.formLabel}>VIN</label>
                  <div style={{display:"flex",gap:6}}>
                    <input style={{...S.formInput,flex:1,textTransform:"uppercase"}} placeholder="17-char VIN"
                      value={editingVehicle.vin||""} onChange={e=>setEditingVehicle(p=>({...p,vin:e.target.value.toUpperCase()}))}/>
                    <button style={{...S.saveBtn,padding:"7px 10px",fontSize:".75rem"}}
                      onClick={()=>{ setShowVinScanner(true); setVinScanTarget("edit"); }}
                      title="Scan VIN barcode">📷</button>
                  </div>
                </div>
                <div style={S.formField}>
                  <label style={S.formLabel}>Stock #</label>
                  <input style={S.formInput} value={editingVehicle.stock||""} onChange={e=>setEditingVehicle(p=>({...p,stock:e.target.value}))}/>
                </div>
                {customFields.map(f=>(
                  <div key={f.id} style={S.formField}>
                    <label style={S.formLabel}>{f.label}</label>
                    <input style={S.formInput} type={f.type==="number"||f.type==="currency"?"number":"text"}
                      value={editingVehicle[f.id]||""} onChange={e=>setEditingVehicle(p=>({...p,[f.id]:e.target.value}))}/>
                  </div>
                ))}
              </div>
              <div style={S.modalActions}>
                <button style={S.cancelBtn} onClick={()=>setEditingVehicle(null)}>Cancel</button>
                <button style={S.saveBtn} onClick={saveEditVehicle}>Save Changes</button>
              </div>
            </>
          )}
        </Modal>
      )}

      {/* ══ ADD/EDIT USER ══ */}
      {(addingUser||editingUser)&&(
        <Modal title={addingUser?"Add User":"Edit User"} onClose={()=>{setAddingUser(false);setEditingUser(null);}}>
          <div style={S.formGrid}>
            <div style={S.formField}>
              <label style={S.formLabel}>Full Name</label>
              <input style={S.formInput} placeholder="e.g. John Smith"
                value={addingUser?newUser.name:editingUser.name}
                onChange={e=>addingUser?setNewUser(p=>({...p,name:e.target.value})):setEditingUser(p=>({...p,name:e.target.value}))}/>
            </div>
            <div style={S.formField}>
              <label style={S.formLabel}>PIN (4–8 digits)</label>
              <input style={S.formInput} placeholder="e.g. 5678" type="password" maxLength={8}
                value={addingUser?newUser.pin:editingUser.pin}
                onChange={e=>addingUser?setNewUser(p=>({...p,pin:e.target.value})):setEditingUser(p=>({...p,pin:e.target.value}))}/>
            </div>
            <div style={{...S.formField,gridColumn:"1/-1"}}>
              <label style={S.formLabel}>Role</label>
              <select style={S.formInput}
                value={addingUser?newUser.role:editingUser.role}
                onChange={e=>addingUser?setNewUser(p=>({...p,role:e.target.value})):setEditingUser(p=>({...p,role:e.target.value}))}>
                {Object.entries(ROLES).map(([k,v])=><option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          </div>
          <div style={S.modalActions}>
            <button style={S.cancelBtn} onClick={()=>{setAddingUser(false);setEditingUser(null);}}>Cancel</button>
            <button style={S.saveBtn} onClick={addingUser?addUser:saveEditUser}>{addingUser?"Add User":"Save Changes"}</button>
          </div>
        </Modal>
      )}

      {/* ══ ADD/EDIT VENDOR ══ */}
      {(addingVendor||editingVendor)&&(
        <Modal title={addingVendor?"Add Vendor":"Edit Vendor"} onClose={()=>{setAddingVendor(false);setEditingVendor(null);}}>
          <div style={S.formGrid}>
            {[["Business Name","name","e.g. Mike's Body Shop"],["Phone","phone","(555) 555-5555"],["Contact Name","contact","Primary contact"]].map(([l,f,ph])=>(
              <div key={f} style={{...S.formField,...(f==="name"?{gridColumn:"1/-1"}:{})}}>
                <label style={S.formLabel}>{l}</label>
                <input style={S.formInput} placeholder={ph}
                  value={addingVendor?newVendor[f]:editingVendor[f]||""}
                  onChange={e=>addingVendor?setNewVendor(p=>({...p,[f]:e.target.value})):setEditingVendor(p=>({...p,[f]:e.target.value}))}/>
              </div>
            ))}
            <div style={S.formField}>
              <label style={S.formLabel}>Type</label>
              <select style={S.formInput}
                value={addingVendor?newVendor.type:editingVendor.type}
                onChange={e=>addingVendor?setNewVendor(p=>({...p,type:e.target.value})):setEditingVendor(p=>({...p,type:e.target.value}))}>
                {VENDOR_TYPES.map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
            <div style={{...S.formField,gridColumn:"1/-1"}}>
              <label style={S.formLabel}>Notes</label>
              <input style={S.formInput} placeholder="Turnaround time, specialties…"
                value={addingVendor?newVendor.notes:editingVendor.notes||""}
                onChange={e=>addingVendor?setNewVendor(p=>({...p,notes:e.target.value})):setEditingVendor(p=>({...p,notes:e.target.value}))}/>
            </div>
          </div>
          <div style={S.modalActions}>
            <button style={S.cancelBtn} onClick={()=>{setAddingVendor(false);setEditingVendor(null);}}>Cancel</button>
            <button style={S.saveBtn} onClick={addingVendor?addVendor:saveEditVendor}>{addingVendor?"Add Vendor":"Save Changes"}</button>
          </div>
        </Modal>
      )}

      {/* ══ EDIT STAGE EDITOR ══ */}
      {editingStages&&(
        <Modal title="Edit Pipeline Stages" onClose={()=>setEditingStages(false)}>
          <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
            {draftStages.map((s,i)=>(
              <div key={s.id} style={{display:"flex",alignItems:"center",gap:8,background:"#0F172A",borderRadius:6,padding:"7px 10px",border:"1px solid #1E293B"}}>
                <div style={{width:14,height:14,borderRadius:3,background:s.color,flexShrink:0}}/>
                <input style={{...S.formInput,flex:1,padding:"3px 7px"}} value={s.label}
                  onChange={e=>setDraftStages(p=>p.map((x,j)=>j===i?{...x,label:e.target.value}:x))}/>
                <select style={{...S.formInput,width:90,padding:"3px 6px"}} value={s.color}
                  onChange={e=>setDraftStages(p=>p.map((x,j)=>j===i?{...x,color:e.target.value}:x))}>
                  {STAGE_COLORS.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
                <button style={S.navBtn} disabled={i===0} onClick={()=>moveDraftStage(i,-1)}>▲</button>
                <button style={S.navBtn} disabled={i===draftStages.length-1} onClick={()=>moveDraftStage(i,1)}>▼</button>
                <button style={S.deleteSmall} onClick={()=>removeDraftStage(s.id)}>✕</button>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:6,marginBottom:14}}>
            <input style={{...S.formInput,flex:1}} placeholder="New stage name" value={newStageName} onChange={e=>setNewStageName(e.target.value)}/>
            <select style={{...S.formInput,width:100}} value={newStageColor} onChange={e=>setNewStageColor(e.target.value)}>
              {STAGE_COLORS.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
            <button style={S.saveBtn} onClick={addDraftStage}>Add</button>
          </div>
          <div style={S.modalActions}>
            <button style={S.cancelBtn} onClick={()=>setEditingStages(false)}>Cancel</button>
            <button style={S.saveBtn} onClick={saveStages}>Save Stages</button>
          </div>
        </Modal>
      )}

      {/* ══ CUSTOM FIELD EDITOR ══ */}
      {editingFields&&(
        <Modal title="Custom Vehicle Fields" onClose={()=>setEditingFields(false)}>
          <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
            {draftFields.length===0&&<div style={S.emptyText}>No custom fields yet.</div>}
            {draftFields.map(f=>(
              <div key={f.id} style={{display:"flex",alignItems:"center",gap:8,background:"#0F172A",borderRadius:6,padding:"7px 10px",border:"1px solid #1E293B"}}>
                <input style={{...S.formInput,flex:1,padding:"3px 7px"}} value={f.label}
                  onChange={e=>setDraftFields(p=>p.map(x=>x.id===f.id?{...x,label:e.target.value}:x))}/>
                <select style={{...S.formInput,width:100,padding:"3px 6px"}} value={f.type}
                  onChange={e=>setDraftFields(p=>p.map(x=>x.id===f.id?{...x,type:e.target.value}:x))}>
                  {FIELD_TYPES.map(t=><option key={t}>{t}</option>)}
                </select>
                <button style={S.deleteSmall} onClick={()=>removeDraftField(f.id)}>✕</button>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:6,marginBottom:14}}>
            <input style={{...S.formInput,flex:1}} placeholder="Field name (e.g. Color, Mileage)" value={newFieldName} onChange={e=>setNewFieldName(e.target.value)}/>
            <select style={{...S.formInput,width:100}} value={newFieldType} onChange={e=>setNewFieldType(e.target.value)}>
              {FIELD_TYPES.map(t=><option key={t}>{t}</option>)}
            </select>
            <button style={S.saveBtn} onClick={addDraftField}>Add</button>
          </div>
          <div style={{color:"#475569",fontSize:".72rem",marginBottom:12}}>
            Field types: <strong style={{color:"#94A3B8"}}>text</strong> = any text · <strong style={{color:"#94A3B8"}}>number</strong> = numeric · <strong style={{color:"#94A3B8"}}>currency</strong> = dollar amount
          </div>
          <div style={S.modalActions}>
            <button style={S.cancelBtn} onClick={()=>setEditingFields(false)}>Cancel</button>
            <button style={S.saveBtn} onClick={saveFields}>Save Fields</button>
          </div>
        </Modal>
      )}

      {/* ══ VEHICLE DETAIL ══ */}
      {detail&&(
        <Modal title={`${detail.year} ${detail.make} ${detail.model}`} wide onClose={()=>setDetailVehicleId(null)}>
          <div style={S.tabBar}>
            {[["info","ℹ️ Info"],["parts","🔩 Parts"],["photos","📷 Photos"],["vendors","🏢 Vendors"],["notes","📝 Notes"]].map(([t,l])=>(
              <button key={t} style={{...S.tabBtn,...(detailTab===t?S.tabBtnActive:{})}} onClick={()=>setDetailTab(t)}>
                {l}
                {t==="parts"&&vParts(detail.id).length>0&&<span style={S.tabBadge}>{vParts(detail.id).length}</span>}
                {t==="photos"&&vPhotos(detail.id).length>0&&<span style={S.tabBadge}>{vPhotos(detail.id).length}</span>}
                {t==="notes"&&vNotes(detail.id).length>0&&<span style={S.tabBadge}>{vNotes(detail.id).length}</span>}
                {t==="vendors"&&vJobs(detail.id).length>0&&<span style={S.tabBadge}>{vJobs(detail.id).length}</span>}
              </button>
            ))}
          </div>
          <div style={{padding:"16px 18px",overflowY:"auto",maxHeight:"65vh"}}>

            {/* INFO */}
            {detailTab==="info"&&(
              <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
                <div style={{flex:"1 1 210px",display:"flex",flexDirection:"column",gap:14}}>
                  <Section title="Vehicle Info">
                    <InfoRow label="VIN"    value={detail.vin||"—"}/>
                    <InfoRow label="Stock #" value={detail.stock||"—"}/>
                    <InfoRow label="Added"   value={daysAgo(detail.addedAt)}/>
                    {detail.addedBy&&<InfoRow label="Added By" value={userById(detail.addedBy)?.name||"—"}/>}
                    {customFields.map(f=>(
                      <InfoRow key={f.id} label={f.label}
                        value={f.type==="currency"&&detail[f.id]?fmt$(detail[f.id]):detail[f.id]||"—"}/>
                    ))}
                    <InfoRow label="Parts Cost" value={fmt$(vCost(detail.id))} highlight/>
                  </Section>
                  {canEdit&&(
                    <button style={S.saveBtn} onClick={()=>setEditingVehicle({...detail})}>✏️ Edit Vehicle Info</button>
                  )}
                </div>
                <div style={{flex:"1 1 210px"}}>
                  <Section title="Pipeline Stage">
                    <div style={{display:"flex",flexDirection:"column",gap:4,marginTop:4}}>
                      {stages.map((s,i)=>(
                        <button key={s.id} style={{...S.stageBtn,background:detail.stage===s.id?s.color:"transparent",borderColor:s.color,color:detail.stage===s.id?"#fff":accentOf(s.color)}}
                          onClick={()=>canEdit&&setStage(detail.id,s.id)}>
                          <span style={{fontSize:".65rem",opacity:.6,marginRight:6}}>{i+1}.</span>{s.label}
                        </button>
                      ))}
                    </div>
                  </Section>
                </div>
                {canEdit&&(
                  <div style={{width:"100%",marginTop:8}}>
                    {confirmDelete===detail.id?(
                      <div style={{background:"#1E293B",border:"1px solid #7F1D1D",borderRadius:7,padding:12}}>
                        <div style={{color:"#F87171",fontSize:".85rem",marginBottom:8}}>Delete this vehicle and all its data?</div>
                        <div style={{display:"flex",gap:8}}>
                          <button style={S.deleteBtn} onClick={()=>deleteVehicle(detail.id)}>Yes, Delete</button>
                          <button style={S.cancelBtn} onClick={()=>setConfirmDelete(null)}>Cancel</button>
                        </div>
                      </div>
                    ):(
                      <button style={S.deleteBtn} onClick={()=>setConfirmDelete(detail.id)}>🗑 Remove Vehicle</button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* PARTS */}
            {detailTab==="parts"&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{fontSize:".82rem",color:"#94A3B8"}}>Total: <strong style={{color:"#FCD34D"}}>{fmt$(vCost(detail.id))}</strong></div>
                {canEdit&&(
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    <input style={{...S.partInput,flex:2}} placeholder="Part / labor description" value={newPart.name} onChange={e=>setNewPart(p=>({...p,name:e.target.value}))}/>
                    <input style={{...S.partInput,width:90}} placeholder="Cost $" type="number" value={newPart.cost} onChange={e=>setNewPart(p=>({...p,cost:e.target.value}))}/>
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
                  {vParts(detail.id).length===0&&<div style={S.emptyText}>No parts added yet.</div>}
                  {vParts(detail.id).map(p=>(
                    editingPart?.id===p.id?(
                      <div key={p.id} style={{...S.partRow,flexWrap:"wrap",gap:6}}>
                        <input style={{...S.partInput,flex:2}} value={editingPart.name} onChange={e=>setEditingPart(x=>({...x,name:e.target.value}))}/>
                        <input style={{...S.partInput,width:90}} type="number" value={editingPart.cost} onChange={e=>setEditingPart(x=>({...x,cost:e.target.value}))}/>
                        <select style={{...S.partInput,width:110}} value={editingPart.status} onChange={e=>setEditingPart(x=>({...x,status:e.target.value}))}>
                          <option value="ordered">Ordered</option><option value="received">Received</option>
                          <option value="installed">Installed</option><option value="pending">Pending</option>
                        </select>
                        <button style={S.saveBtn} onClick={saveEditPart}>Save</button>
                        <button style={S.cancelBtn} onClick={()=>setEditingPart(null)}>Cancel</button>
                      </div>
                    ):(
                      <div key={p.id} style={S.partRow}>
                        <div style={{flex:1}}>
                          <div style={{fontSize:".8rem",color:"#E2E8F0"}}>{p.name}</div>
                          {p.vendorId&&vendorById(p.vendorId)&&<div style={{fontSize:".65rem",color:"#7C3AED"}}>📦 {vendorById(p.vendorId).name}</div>}
                        </div>
                        <div style={{fontSize:".8rem",color:"#FCD34D",minWidth:55,textAlign:"right"}}>{fmt$(p.cost)}</div>
                        {canEdit?(
                          <select style={{...S.statusBadge,background:partStatusColor(p.status),border:"none",cursor:"pointer"}} value={p.status} onChange={e=>updatePartStatus(p.id,e.target.value)}>
                            <option value="ordered">Ordered</option><option value="received">Received</option>
                            <option value="installed">Installed</option><option value="pending">Pending</option>
                          </select>
                        ):<span style={{...S.statusBadge,background:partStatusColor(p.status)}}>{p.status}</span>}
                        {canEdit&&<button style={S.editSmall} onClick={()=>setEditingPart({...p})}>✏️</button>}
                        {canEdit&&<button style={S.deleteSmall} onClick={()=>deletePart(p.id)}>✕</button>}
                      </div>
                    )
                  ))}
                </div>
              </div>
            )}

            {/* PHOTOS */}
            {detailTab==="photos"&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                {canEdit&&(
                  <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                    <input style={{...S.partInput,flex:2}} placeholder="Caption (optional)" value={photoCaption} onChange={e=>setPhotoCaption(e.target.value)}/>
                    <button style={{...S.saveBtn,...(uploading?{opacity:.6}:{})}} disabled={uploading} onClick={()=>fileInputRef.current.click()}>
                      {uploading?"Uploading…":"📷 Upload Photos"}
                    </button>
                    <input ref={fileInputRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={handlePhotoUpload}/>
                  </div>
                )}
                {vPhotos(detail.id).length===0&&<div style={S.emptyText}>No photos yet.</div>}
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:10}}>
                  {vPhotos(detail.id).map((ph,idx)=>(
                    <div key={ph.id} style={{position:"relative",height:110,borderRadius:7,overflow:"hidden",cursor:"pointer",border:"1px solid #334155"}}
                      onClick={()=>setLightbox({photos:vPhotos(detail.id),idx})}>
                      <img src={ph.url} alt={ph.caption} style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                      <div style={{position:"absolute",bottom:0,left:0,right:0,background:"rgba(0,0,0,.65)",padding:"5px 7px"}}>
                        <div style={{fontSize:".65rem",color:"#E2E8F0",lineHeight:1.2}}>{ph.caption}</div>
                        <div style={{fontSize:".6rem",color:"#94A3B8"}}>{userById(ph.uploadedBy)?.name||"—"}</div>
                      </div>
                      {canEdit&&(
                        <button style={{position:"absolute",top:5,right:5,background:"rgba(0,0,0,.6)",border:"none",color:"#fff",borderRadius:"50%",width:20,height:20,cursor:"pointer",fontSize:".65rem",fontFamily:"inherit",display:"flex",alignItems:"center",justifyContent:"center"}}
                          onClick={e=>{e.stopPropagation();deletePhoto(ph);}}>✕</button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* VENDOR JOBS */}
            {detailTab==="vendors"&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{fontSize:".82rem",color:"#94A3B8"}}>
                  Vendor jobs · Total: <strong style={{color:"#FCD34D"}}>{fmt$(vJobs(detail.id).reduce((a,j)=>a+(parseFloat(j.cost)||0),0))}</strong>
                </div>
                {canEdit&&vendors.length>0&&(
                  addingJob?(
                    <div style={{background:"#0F172A",border:"1px solid #334155",borderRadius:7,padding:12,display:"flex",flexDirection:"column",gap:8}}>
                      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                        <select style={{...S.partInput,flex:1}} value={newJob.vendorId} onChange={e=>setNewJob(p=>({...p,vendorId:e.target.value}))}>
                          <option value="">Select vendor…</option>
                          {vendors.map(v=><option key={v.id} value={v.id}>{v.name} ({v.type})</option>)}
                        </select>
                        <input style={{...S.partInput,flex:2}} placeholder="Work description" value={newJob.description} onChange={e=>setNewJob(p=>({...p,description:e.target.value}))}/>
                        <input style={{...S.partInput,width:90}} placeholder="Est. cost $" type="number" value={newJob.cost} onChange={e=>setNewJob(p=>({...p,cost:e.target.value}))}/>
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
                  ):(
                    <button style={S.saveBtn} onClick={()=>setAddingJob(true)}>+ Assign Vendor Job</button>
                  )
                )}
                {vendors.length===0&&<div style={S.emptyText}>No vendors yet. Add them from the Vendors tab first.</div>}
                {vJobs(detail.id).length===0&&vendors.length>0&&<div style={S.emptyText}>No vendor jobs assigned.</div>}
                {vJobs(detail.id).map(j=>{
                  const vnd=vendorById(j.vendorId);
                  return editingJob?.id===j.id?(
                    <div key={j.id} style={{...S.partRow,flexWrap:"wrap",gap:6}}>
                      <input style={{...S.partInput,flex:2}} value={editingJob.description} onChange={e=>setEditingJob(x=>({...x,description:e.target.value}))}/>
                      <input style={{...S.partInput,width:90}} type="number" value={editingJob.cost} onChange={e=>setEditingJob(x=>({...x,cost:e.target.value}))}/>
                      <select style={{...S.partInput,width:130}} value={editingJob.status} onChange={e=>setEditingJob(x=>({...x,status:e.target.value}))}>
                        <option value="pending">Pending</option><option value="in_progress">In Progress</option>
                        <option value="completed">Completed</option><option value="cancelled">Cancelled</option>
                      </select>
                      <button style={S.saveBtn} onClick={saveEditJob}>Save</button>
                      <button style={S.cancelBtn} onClick={()=>setEditingJob(null)}>Cancel</button>
                    </div>
                  ):(
                    <div key={j.id} style={S.partRow}>
                      <div style={{flex:1}}>
                        <div style={{fontSize:".8rem",color:"#E2E8F0"}}>{j.description}</div>
                        {vnd&&<div style={{fontSize:".68rem",color:"#C4B5FD"}}>🏢 {vnd.name} · {vnd.type}</div>}
                      </div>
                      <div style={{fontSize:".8rem",color:"#FCD34D",minWidth:55,textAlign:"right"}}>{fmt$(j.cost)}</div>
                      {canEdit?(
                        <select style={{...S.statusBadge,background:jobStatusColor(j.status),border:"none",cursor:"pointer"}} value={j.status} onChange={e=>updateJobStatus(j.id,e.target.value)}>
                          <option value="pending">Pending</option><option value="in_progress">In Progress</option>
                          <option value="completed">Completed</option><option value="cancelled">Cancelled</option>
                        </select>
                      ):<span style={{...S.statusBadge,background:jobStatusColor(j.status)}}>{jobStatusLabel(j.status)}</span>}
                      {canEdit&&<button style={S.editSmall} onClick={()=>setEditingJob({...j})}>✏️</button>}
                      {canEdit&&<button style={S.deleteSmall} onClick={()=>deleteJob(j.id)}>✕</button>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* NOTES */}
            {detailTab==="notes"&&(
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <div style={{display:"flex",flexDirection:"column",gap:7,maxHeight:320,overflowY:"auto"}}>
                  {vNotes(detail.id).length===0&&<div style={S.emptyText}>No notes yet.</div>}
                  {vNotes(detail.id).map(n=>{
                    const author=userById(n.userId);
                    return (
                      <div key={n.id} style={{background:"#0F172A",borderRadius:6,padding:"9px 11px",border:"1px solid #1E293B"}}>
                        <div style={{fontSize:".82rem",color:"#CBD5E1",lineHeight:1.4}}>{n.text}</div>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:5}}>
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            {author&&<div style={{...S.avatar,width:18,height:18,fontSize:".55rem",background:avatarColor(author.name)}}>{initials(author.name)}</div>}
                            <span style={{fontSize:".65rem",color:"#475569"}}>{author?.name||"Unknown"} · {n.ts?.toDate?.().toLocaleString()||"—"}</span>
                          </div>
                          {canEdit&&<button style={S.deleteSmall} onClick={()=>deleteNote(n.id)}>✕</button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {canEdit&&(
                  <div style={{display:"flex",gap:8,alignItems:"flex-start"}}>
                    <textarea style={{flex:1,background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",padding:"7px 10px",borderRadius:5,fontFamily:"inherit",fontSize:".82rem",outline:"none",resize:"none"}}
                      rows={2} placeholder="Add a note…" value={noteInput} onChange={e=>setNoteInput(e.target.value)}
                      onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();addNote();}}}/>
                    <button style={S.saveBtn} onClick={addNote}>Add</button>
                  </div>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* LIGHTBOX */}
      {lightbox&&(
        <div style={{...S.overlay,zIndex:200}} onClick={()=>setLightbox(null)}>
          <div style={{position:"relative",maxWidth:"90vw",maxHeight:"90vh"}} onClick={e=>e.stopPropagation()}>
            <img src={lightbox.photos[lightbox.idx].url} alt="" style={{maxWidth:"90vw",maxHeight:"80vh",borderRadius:8,objectFit:"contain"}}/>
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

function VehicleCard({vehicle,stage,cost,partCount,noteCount,photoCount,jobCount,onOpen,onMove,stageIdx,totalStages}) {
  return (
    <div style={S.card} onClick={onOpen}>
      <div style={{height:3,background:stage.color}}/>
      <div style={{padding:"9px 10px 5px"}}>
        <div style={{fontSize:".82rem",fontWeight:700,color:"#F1F5F9",lineHeight:1.3}}>{vehicle.year} {vehicle.make} {vehicle.model||"—"}</div>
        {vehicle.stock&&<div style={{fontSize:".7rem",color:"#64748B",marginTop:1}}>Stock #{vehicle.stock}</div>}
        {vehicle.vin&&<div style={{fontSize:".65rem",color:"#334155",fontFamily:"monospace",marginTop:1}}>{vehicle.vin}</div>}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:5}}>
          <span style={{fontSize:".62rem",color:"#475569"}}>{daysAgo(vehicle.addedAt)}</span>
          {cost>0&&<span style={{fontSize:".7rem",color:"#FCD34D",fontWeight:600}}>{fmt$(cost)}</span>}
        </div>
        <div style={{display:"flex",gap:4,marginTop:4,flexWrap:"wrap"}}>
          {partCount>0&&<span style={S.badge}>🔩{partCount}</span>}
          {noteCount>0&&<span style={S.badge}>📝{noteCount}</span>}
          {photoCount>0&&<span style={S.badge}>📷{photoCount}</span>}
          {jobCount>0&&<span style={S.badge}>🏢{jobCount}</span>}
        </div>
      </div>
      {onMove&&(
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

const S = {
  root:        { minHeight:"100vh", background:"#0F172A", color:"#E2E8F0", fontFamily:"'DM Mono','Fira Mono','Courier New',monospace", display:"flex", flexDirection:"column" },
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
  board:       { flex:1, display:"grid", overflowX:"auto", borderTop:"1px solid #1E293B" },
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
  settingsCard:{ background:"#1E293B", border:"1px solid #334155", borderRadius:9, padding:20 },
  pageWrap:    { flex:1, padding:"24px 28px", overflowY:"auto" },
  pageHeader:  { display:"flex", alignItems:"center", gap:16, flexWrap:"wrap", marginBottom:24 },
  pageTitle:   { fontSize:"1.2rem", fontWeight:700, color:"#F1F5F9" },
  vendorGrid:  { display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))", gap:14 },
  vendorCard:  { background:"#1E293B", border:"1px solid #2D3F58", borderRadius:9, padding:16, display:"flex", flexDirection:"column", gap:8 },
  vendorIcon:  { width:36, height:36, borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:700, fontSize:"1rem", color:"#fff", flexShrink:0 },
  userTable:   { background:"#1E293B", border:"1px solid #334155", borderRadius:9, overflow:"hidden", marginBottom:20 },
  userTableHead:{ display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr", padding:"8px 16px", background:"#131C2E", borderBottom:"1px solid #334155" },
  thCell:      { fontSize:".65rem", color:"#475569", letterSpacing:".08em", textTransform:"uppercase" },
  userRow:     { display:"grid", gridTemplateColumns:"2fr 1fr 1fr 1fr", padding:"10px 16px", borderBottom:"1px solid #1E293B", alignItems:"center" },
  saveBtn:     { background:"#2563EB", color:"#fff", border:"none", padding:"7px 14px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:".78rem", fontWeight:600, whiteSpace:"nowrap" },
  cancelBtn:   { background:"transparent", color:"#94A3B8", border:"1px solid #334155", padding:"7px 13px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:".78rem" },
  deleteBtn:   { background:"#7F1D1D", color:"#FCA5A5", border:"1px solid #991B1B", padding:"7px 13px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:".78rem" },
  deleteSmall: { background:"transparent", border:"none", color:"#F87171", cursor:"pointer", fontSize:".78rem", fontFamily:"inherit", padding:"0 3px" },
  editSmall:   { background:"transparent", border:"none", cursor:"pointer", fontSize:".78rem", fontFamily:"inherit", padding:"0 3px" },
  emptyText:   { color:"#334155", fontSize:".76rem", fontStyle:"italic" },
  lbBtn:       { background:"#1E293B", border:"1px solid #334155", color:"#94A3B8", padding:"6px 14px", borderRadius:5, cursor:"pointer", fontFamily:"inherit", fontSize:".78rem" },
};
