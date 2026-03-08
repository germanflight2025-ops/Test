const express=require("express");
const session=require("express-session");
const multer=require("multer");
const fs=require("fs");
const path=require("path");
const bcrypt=require("bcrypt");
const PDFDocument=require("pdfkit");

const app=express();
const PORT=process.env.PORT||3000;

app.use(express.json({limit:"10mb"}));
app.use(express.urlencoded({extended:true,limit:"10mb"}));
app.use(session({secret:"fuhrpark-secret-v5",resave:false,saveUninitialized:false}));
app.use(express.static("public"));
app.use("/uploads",express.static("uploads"));

if(!fs.existsSync("data")) fs.mkdirSync("data");
if(!fs.existsSync("uploads")) fs.mkdirSync("uploads");

const USERS_FILE="data/users.json";
const LOCATIONS_FILE="data/locations.json";
const VEHICLES_FILE="data/vehicles.json";
const DAMAGES_FILE="data/damages.json";

function readJson(file,fallback){ if(!fs.existsSync(file)) return fallback; try{return JSON.parse(fs.readFileSync(file,"utf8"));}catch{return fallback;} }
function writeJson(file,data){ fs.writeFileSync(file,JSON.stringify(data,null,2),"utf8"); }
function slugify(text){ return String(text||"").toLowerCase().replace(/ä/g,"ae").replace(/ö/g,"oe").replace(/ü/g,"ue").replace(/ß/g,"ss").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,""); }
function getLocationById(id){ return readJson(LOCATIONS_FILE,[]).find(l=>Number(l.id)===Number(id))||null; }
function getNextDamageNumber(locationCode){ const year=new Date().getFullYear(); const items=readJson(DAMAGES_FILE,[]); const count=items.filter(i=>String(i.damageNumber||"").startsWith(`${locationCode}-${year}-`)).length+1; return `${locationCode}-${year}-${String(count).padStart(4,"0")}`; }

function ensureSeed(){
 if(!fs.existsSync(LOCATIONS_FILE)) writeJson(LOCATIONS_FILE,[{id:1,name:"Frankfurt",code:"FFM"},{id:2,name:"München",code:"MUC"}]);
 if(!fs.existsSync(USERS_FILE)) writeJson(USERS_FILE,[
  {username:"hauptadmin",password:bcrypt.hashSync("admin123",10),role:"superadmin",locationId:null},
  {username:"frankfurtadmin",password:bcrypt.hashSync("admin123",10),role:"admin",locationId:1},
  {username:"muenchenadmin",password:bcrypt.hashSync("admin123",10),role:"admin",locationId:2},
  {username:"user",password:bcrypt.hashSync("user123",10),role:"user",locationId:1}
 ]);
 if(!fs.existsSync(VEHICLES_FILE)) writeJson(VEHICLES_FILE,[
  {id:1,locationId:1,kennzeichen:"F-EC-149",hersteller:"Iveco",tuevFaelligAm:"2027-06-01",uvvFaelligAm:"2025-04-01",inspektionKm:"31156",wartungFahrtenschreiber:"2025-04-01",einsatzbereit:"Ja",status:"aktiv",fehlerart:"",standortBereich:"Iveco"},
  {id:2,locationId:1,kennzeichen:"F-EC-605",hersteller:"Iveco",tuevFaelligAm:"2026-12-01",uvvFaelligAm:"2026-12-01",inspektionKm:"21463",wartungFahrtenschreiber:"2024-12-01",einsatzbereit:"Ja",status:"aktiv",fehlerart:"Bremsen",standortBereich:"Sachse"},
  {id:3,locationId:1,kennzeichen:"F-EC-647",hersteller:"Iveco",tuevFaelligAm:"2027-04-01",uvvFaelligAm:"2024-01-01",inspektionKm:"33686",wartungFahrtenschreiber:"2025-01-01",einsatzbereit:"Nein",status:"werkstatt",fehlerart:"Bremsen",standortBereich:"Rosbach/Truck&Trailer"},
  {id:4,locationId:2,kennzeichen:"M-XY-789",hersteller:"Ford",tuevFaelligAm:"2027-01-01",uvvFaelligAm:"2026-12-01",inspektionKm:"18200",wartungFahrtenschreiber:"2025-11-01",einsatzbereit:"Ja",status:"aktiv",fehlerart:"",standortBereich:"Berger"}
 ]);
 if(!fs.existsSync(DAMAGES_FILE)) writeJson(DAMAGES_FILE,[]);
}
ensureSeed();

function auth(req,res,next){ if(!req.session.user) return res.status(401).json({error:"Nicht eingeloggt"}); next(); }
function isSuperAdmin(user){ return user&&user.role==="superadmin"; }
function isAdmin(user){ return user&&(user.role==="admin"||user.role==="superadmin"); }
function adminOnly(req,res,next){ if(!isAdmin(req.session.user)) return res.status(403).json({error:"Nur Admin"}); next(); }
function superAdminOnly(req,res,next){ if(!isSuperAdmin(req.session.user)) return res.status(403).json({error:"Nur Haupt-Admin"}); next(); }
function canAccessLocation(user,locationId){ if(isSuperAdmin(user)) return true; return Number(user.locationId)===Number(locationId); }
function visibleUsers(user){ const users=readJson(USERS_FILE,[]); if(isSuperAdmin(user)) return users; return users.filter(u=>Number(u.locationId)===Number(user.locationId)); }
function visibleVehicles(user){ const items=readJson(VEHICLES_FILE,[]); if(isSuperAdmin(user)) return items; return items.filter(v=>Number(v.locationId)===Number(user.locationId)); }
function visibleDamages(user){ const items=readJson(DAMAGES_FILE,[]); if(isSuperAdmin(user)) return items; if(user.role==="admin") return items.filter(i=>Number(i.locationId)===Number(user.locationId)); return items.filter(i=>Number(i.locationId)===Number(user.locationId)&&i.createdBy===user.username); }
function vehicleStatusLabel(v){ if(v.status==="werkstatt") return "Werkstatt"; if(v.status==="nicht-einsatzbereit") return "Nicht Einsatzbereit"; return "Aktiv"; }
function buildDashboard(user){
 const vehicles=visibleVehicles(user); const damages=visibleDamages(user); const byLocation={}; const grouped={};
 const totals={fahrzeugeGesamt:vehicles.length,aktiv:0,werkstatt:0,nichtEinsatzbereit:0,unfaelle:damages.length,adblueFehler:0,bremsen:0,oelwechsel:0,reifenwechsel:0};
 for(const v of vehicles){
  const locName=getLocationById(v.locationId)?.name||"Unbekannt";
  if(!byLocation[locName]) byLocation[locName]={total:0,aktiv:0,werkstatt:0,nichtEinsatzbereit:0};
  byLocation[locName].total+=1;
  if(v.status==="werkstatt"){ byLocation[locName].werkstatt+=1; totals.werkstatt+=1; }
  else if(v.status==="nicht-einsatzbereit"){ byLocation[locName].nichtEinsatzbereit+=1; totals.nichtEinsatzbereit+=1; }
  else { byLocation[locName].aktiv+=1; totals.aktiv+=1; }

  const area=v.standortBereich||"Ohne Bereich";
  if(!grouped[locName]) grouped[locName]={};
  if(!grouped[locName][area]) grouped[locName][area]=[];
  grouped[locName][area].push(v);

  const f=String(v.fehlerart||"").toLowerCase();
  if(f.includes("unfall")) totals.unfaelle+=1;
  if(f.includes("adblue")) totals.adblueFehler+=1;
  if(f.includes("brems")) totals.bremsen+=1;
  if(f.includes("öl")||f.includes("oel")) totals.oelwechsel+=1;
  if(f.includes("reifen")) totals.reifenwechsel+=1;
 }
 return {totals,byLocation,grouped};
}

const storage=multer.diskStorage({
 destination:(req,file,cb)=>cb(null,"uploads"),
 filename:(req,file,cb)=>cb(null,`${Date.now()}-${Math.round(Math.random()*1e9)}${path.extname(file.originalname||"")}`)
});
const upload=multer({storage});

app.get("/api/me",(req,res)=>{ const user=req.session.user||null; if(!user) return res.json(null); const loc=user.locationId?getLocationById(user.locationId):null; res.json({...user,locationName:loc?loc.name:"Alle Standorte"}); });

app.post("/api/login",(req,res)=>{ const {username,password}=req.body; const users=readJson(USERS_FILE,[]); const user=users.find(u=>u.username===username); if(!user) return res.json({success:false}); if(!bcrypt.compareSync(password,user.password)) return res.json({success:false}); req.session.user={username:user.username,role:user.role,locationId:user.locationId??null}; res.json({success:true,role:user.role}); });

app.get("/api/logout",(req,res)=>{ req.session.destroy(()=>res.json({success:true})); });

app.get("/api/locations",auth,(req,res)=>{ const items=readJson(LOCATIONS_FILE,[]); if(isSuperAdmin(req.session.user)) return res.json(items); res.json(items.filter(l=>Number(l.id)===Number(req.session.user.locationId))); });

app.post("/api/locations",auth,superAdminOnly,(req,res)=>{ const {name,code}=req.body; if(!name||!code) return res.status(400).json({error:"Name und Code erforderlich"}); const items=readJson(LOCATIONS_FILE,[]); if(items.find(i=>i.name.toLowerCase()===String(name).toLowerCase()||i.code.toLowerCase()===String(code).toLowerCase())) return res.status(400).json({error:"Standort existiert bereits"}); const item={id:Date.now(),name,code:slugify(code).toUpperCase().slice(0,6)||"LOC"}; items.push(item); writeJson(LOCATIONS_FILE,items); res.json({success:true,item}); });

app.get("/api/users",auth,adminOnly,(req,res)=>{ res.json(visibleUsers(req.session.user).map(u=>({username:u.username,role:u.role,locationId:u.locationId,locationName:u.locationId?(getLocationById(u.locationId)?.name||""):"Alle Standorte"}))); });

app.post("/api/users",auth,adminOnly,(req,res)=>{
 const {username,password,role,locationId}=req.body;
 if(!username||!password||!role) return res.status(400).json({error:"Bitte alle Felder ausfüllen"});
 const users=readJson(USERS_FILE,[]);
 if(users.find(u=>u.username===username)) return res.status(400).json({error:"Benutzer existiert bereits"});
 let finalLocationId=locationId?Number(locationId):null;
 if(!isSuperAdmin(req.session.user)){ finalLocationId=Number(req.session.user.locationId); if(role==="superadmin") return res.status(403).json({error:"Nicht erlaubt"}); }
 else if(role!=="superadmin"&&!finalLocationId) return res.status(400).json({error:"Standort auswählen"});
 users.push({username,password:bcrypt.hashSync(password,10),role,locationId:role==="superadmin"?null:finalLocationId});
 writeJson(USERS_FILE,users); res.json({success:true});
});

app.get("/api/vehicles",auth,(req,res)=>{ res.json(visibleVehicles(req.session.user).map(v=>({...v,locationName:getLocationById(v.locationId)?.name||"",statusLabel:vehicleStatusLabel(v)}))); });

app.post("/api/vehicles",auth,adminOnly,(req,res)=>{
 const {kennzeichen,hersteller,tuevFaelligAm,uvvFaelligAm,inspektionKm,wartungFahrtenschreiber,einsatzbereit,status,fehlerart,standortBereich,locationId}=req.body;
 if(!kennzeichen) return res.status(400).json({error:"Kennzeichen erforderlich"});
 const items=readJson(VEHICLES_FILE,[]);
 let finalLocationId=locationId?Number(locationId):null;
 if(!isSuperAdmin(req.session.user)) finalLocationId=Number(req.session.user.locationId);
 else if(!finalLocationId) return res.status(400).json({error:"Standort auswählen"});
 items.push({id:Date.now(),locationId:finalLocationId,kennzeichen,hersteller:hersteller||"",tuevFaelligAm:tuevFaelligAm||"",uvvFaelligAm:uvvFaelligAm||"",inspektionKm:inspektionKm||"",wartungFahrtenschreiber:wartungFahrtenschreiber||"",einsatzbereit:einsatzbereit||"Ja",status:status||"aktiv",fehlerart:fehlerart||"",standortBereich:standortBereich||"Ohne Bereich"});
 writeJson(VEHICLES_FILE,items); res.json({success:true});
});

app.put("/api/vehicles/:id",auth,adminOnly,(req,res)=>{
 const items=readJson(VEHICLES_FILE,[]);
 const found=items.find(v=>Number(v.id)===Number(req.params.id));
 if(!found) return res.status(404).json({error:"Fahrzeug nicht gefunden"});
 if(!canAccessLocation(req.session.user,found.locationId)) return res.status(403).json({error:"Kein Zugriff"});
 ["kennzeichen","hersteller","tuevFaelligAm","uvvFaelligAm","inspektionKm","wartungFahrtenschreiber","einsatzbereit","status","fehlerart","standortBereich"].forEach(key=>{ if(Object.prototype.hasOwnProperty.call(req.body,key)) found[key]=req.body[key]; });
 writeJson(VEHICLES_FILE,items); res.json({success:true});
});

app.delete("/api/vehicles/:id",auth,adminOnly,(req,res)=>{
 const items=readJson(VEHICLES_FILE,[]);
 const found=items.find(v=>Number(v.id)===Number(req.params.id));
 if(!found) return res.status(404).json({error:"Fahrzeug nicht gefunden"});
 if(!canAccessLocation(req.session.user,found.locationId)) return res.status(403).json({error:"Kein Zugriff"});
 writeJson(VEHICLES_FILE,items.filter(v=>Number(v.id)!==Number(req.params.id))); res.json({success:true});
});

app.get("/api/dashboard",auth,adminOnly,(req,res)=>{ res.json(buildDashboard(req.session.user)); });

app.post("/api/damages",auth,upload.array("photos",5),(req,res)=>{
 const user=req.session.user;
 const items=readJson(DAMAGES_FILE,[]);
 const locationId=user.role==="superadmin"?Number(req.body.locationId):Number(user.locationId);
 if(!locationId) return res.status(400).json({error:"Standort fehlt"});
 if(!canAccessLocation(user,locationId)) return res.status(403).json({error:"Kein Zugriff auf Standort"});
 const location=getLocationById(locationId);
 if(!location) return res.status(400).json({error:"Standort ungültig"});
 const files=(req.files||[]).map(f=>({stored:f.filename,original:f.originalname}));
 const item={id:Date.now(),damageNumber:getNextDamageNumber(location.code),locationId,locationName:location.name,createdBy:user.username,status:"offen",createdAt:new Date().toISOString(),fahrername:req.body.fahrername||"",fahrzeug:req.body.fahrzeug||"",datum:req.body.datum||"",uhrzeit:req.body.uhrzeit||"",fahrbereit:req.body.fahrbereit||"",unfallort:req.body.unfallort||"",gps:req.body.gps||"",polizeiVorOrt:req.body.polizeiVorOrt||"",aktenzeichen:req.body.aktenzeichen||"",verletzte:req.body.verletzte||"",unfallbeschreibung:req.body.unfallbeschreibung||"",gegnerName:req.body.gegnerName||"",gegnerKennzeichen:req.body.gegnerKennzeichen||"",gegnerVersicherung:req.body.gegnerVersicherung||"",gegnerTelefon:req.body.gegnerTelefon||"",gegnerAdresse:req.body.gegnerAdresse||"",zeugeName:req.body.zeugeName||"",zeugeTelefon:req.body.zeugeTelefon||"",photos:files};
 items.push(item); writeJson(DAMAGES_FILE,items); res.json({success:true,id:item.id,damageNumber:item.damageNumber});
});

app.get("/api/damages",auth,(req,res)=>{ res.json(visibleDamages(req.session.user)); });

app.post("/api/damages/:id/status",auth,adminOnly,(req,res)=>{
 const items=readJson(DAMAGES_FILE,[]); const found=items.find(i=>String(i.id)===String(req.params.id));
 if(!found) return res.status(404).json({error:"Nicht gefunden"});
 if(!canAccessLocation(req.session.user,found.locationId)) return res.status(403).json({error:"Kein Zugriff"});
 const allowed=["offen","reparatur","erledigt"];
 if(!allowed.includes(req.body.status)) return res.status(400).json({error:"Ungültiger Status"});
 found.status=req.body.status; writeJson(DAMAGES_FILE,items); res.json({success:true});
});

app.get("/api/damages/:id/pdf",auth,(req,res)=>{
 const items=readJson(DAMAGES_FILE,[]); const item=items.find(i=>String(i.id)===String(req.params.id));
 if(!item) return res.status(404).end();
 const user=req.session.user;
 const allowed=isSuperAdmin(user)||(user.role==="admin"&&Number(user.locationId)===Number(item.locationId))||(user.role==="user"&&user.username===item.createdBy&&Number(user.locationId)===Number(item.locationId));
 if(!allowed) return res.status(403).end();
 res.setHeader("Content-Type","application/pdf");
 res.setHeader("Content-Disposition",`inline; filename="${item.damageNumber}.pdf"`);
 const doc=new PDFDocument({margin:40}); doc.pipe(res);
 doc.fontSize(20).text("PDF Unfallbericht",{underline:true}); doc.moveDown(); doc.fontSize(11);
 ["damageNumber","locationName","createdBy","status","fahrername","fahrzeug","datum","uhrzeit","fahrbereit","unfallort","gps","polizeiVorOrt","aktenzeichen","verletzte"].forEach(key=>{});
 doc.text(`Schaden-Nummer: ${item.damageNumber}`); doc.text(`Standort: ${item.locationName}`); doc.text(`Erstellt von: ${item.createdBy}`); doc.text(`Status: ${item.status}`); doc.text(`Fahrername: ${item.fahrername}`); doc.text(`Fahrzeug: ${item.fahrzeug}`); doc.text(`Datum: ${item.datum}`); doc.text(`Uhrzeit: ${item.uhrzeit}`); doc.text(`Fahrzeug fahrbereit: ${item.fahrbereit}`);
 doc.moveDown(); doc.text(`Unfallort: ${item.unfallort}`); doc.text(`GPS: ${item.gps}`); doc.text(`Polizei vor Ort: ${item.polizeiVorOrt}`); doc.text(`Aktenzeichen: ${item.aktenzeichen}`); doc.text(`Verletzte: ${item.verletzte}`);
 doc.moveDown(); doc.text("Unfallbeschreibung:"); doc.text(item.unfallbeschreibung||"-",{width:500}); doc.moveDown();
 doc.text("Unfallgegner:"); doc.text(`Name: ${item.gegnerName}`); doc.text(`Kennzeichen: ${item.gegnerKennzeichen}`); doc.text(`Versicherung: ${item.gegnerVersicherung}`); doc.text(`Telefon: ${item.gegnerTelefon}`); doc.text(`Adresse: ${item.gegnerAdresse}`); doc.moveDown();
 doc.text("Zeuge:"); doc.text(`Name: ${item.zeugeName}`); doc.text(`Telefon: ${item.zeugeTelefon}`);
 for(const photo of (item.photos||[])){ const filePath=path.join("uploads",photo.stored); if(fs.existsSync(filePath)){ doc.addPage(); doc.fontSize(12).text(`Foto: ${photo.original}`); try{ doc.image(filePath,{fit:[500,650],align:"center",valign:"center"}); }catch{} } }
 doc.end();
});

app.listen(PORT,()=>console.log("Server läuft auf "+PORT));
