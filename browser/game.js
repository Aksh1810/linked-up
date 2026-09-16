import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';

let engine, bridge, camera, shadows, tether, canvas;
let reducedMotion = false, robots = new Map(), obstacles = new Map();
const key=(e,pressed)=>{if(pressed&&e.target?.closest('button,input,select,textarea,[contenteditable=true]'))return;if(['KeyW','KeyA','KeyS','KeyD','Space'].includes(e.code)){e.preventDefault();bridge?.invokeMethodAsync('KeyChanged',e.code,pressed);}};
const down=e=>key(e,true), up=e=>key(e,false), resize=()=>engine?.resize(), blur=()=>bridge?.invokeMethodAsync('ClearInput');
const colors={blue:['#38a6cc','#176789'],orange:['#e68045','#98502e'],green:['#62a86d','#356d49'],purple:['#9a79c8','#644a8f']};
export function start(canvasId, color, dotnet, preferences) {
  stop(); bridge=dotnet; canvas=document.getElementById(canvasId);
  engine=new Engine(canvas,true); const current=engine; const scene=new Scene(engine);
  scene.clearColor=Color4.FromHexString('#86c4d4ff'); scene.fogMode=Scene.FOGMODE_EXP2;
  scene.fogDensity=.006; scene.fogColor=Color3.FromHexString('#86c4d4');
  scene.imageProcessingConfiguration.exposure=.88; scene.imageProcessingConfiguration.contrast=1.12;
  camera=new ArcRotateCamera('camera',-Math.PI/2-.42,1.18,16.5,new Vector3(0,1.6,0),scene);
  camera.lowerBetaLimit=.65; camera.upperBetaLimit=1.38; camera.lowerRadiusLimit=10; camera.upperRadiusLimit=22;
  camera.panningSensibility=0; camera.wheelPrecision=60; camera.attachControl(canvas,true);
  configure(preferences ?? {angularSensibilityX:1000,angularSensibilityY:1000,reducedMotion:false});
  const sun=new DirectionalLight('sun',new Vector3(-.55,-1,-.35),scene);
  sun.position=new Vector3(12,18,-10); sun.diffuse=Color3.FromHexString('#ffe1ad'); sun.intensity=1.05;
  sun.autoUpdateExtends=true; sun.autoCalcShadowZBounds=true;
  const fill=new HemisphericLight('sky-fill',new Vector3(0,1,0),scene);
  fill.diffuse=Color3.FromHexString('#c9e7ea'); fill.intensity=.65; fill.groundColor=Color3.FromHexString('#6b858c');
  shadows=new ShadowGenerator(1024,sun); shadows.useBlurExponentialShadowMap=true;
  shadows.blurKernel=16; shadows.bias=.0005; shadows.normalBias=.02; shadows.darkness=.62;
  world(scene);
  window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',blur);window.addEventListener('resize',resize);
  let pending=false, previous=performance.now();
  engine.runRenderLoop(async()=>{
    if(pending || engine!==current)return;
    pending=true;
    try {
      const now=performance.now(), delta=Math.min(Math.max(0,now-previous)/1000,.1); previous=now;
      const state=await dotnet.invokeMethodAsync('Frame',now,camera.alpha);
      if(engine!==current)return;
      if(state){
        snapshot(scene,state,delta,now);
        const local=state.players.find(p=>p.id===color);
        if(local)camera.setTarget(Vector3.Lerp(camera.target,new Vector3(local.position.x,local.position.y+.55,local.position.z),reducedMotion?1:1-Math.exp(-8*delta)));
      }
      scene.render();
    } catch {if(engine===current)await dotnet.invokeMethodAsync('GameplayStatus','The renderer could not update the game.');}
    finally {pending=false;}
  });
}
function material(scene,color,emissive){
  const m=new StandardMaterial(color,scene);m.diffuseColor=Color3.FromHexString(color);
  m.specularColor=Color3.FromHexString('#163247').scale(.18);
  if(emissive)m.emissiveColor=Color3.FromHexString(emissive).scale(.72);
  return m;
}
function box(scene,name,size,position,paint,parent){
  const mesh=MeshBuilder.CreateBox(name,{width:size[0],height:size[1],depth:size[2]},scene);
  mesh.position.set(...position);mesh.material=paint;mesh.parent=parent;mesh.receiveShadows=true;
  return mesh;
}
function world(scene){
  const soil=material(scene,'#4b3831'),grass=material(scene,'#527f5a'),edge=material(scene,'#294b39');
  box(scene,'bounded-platform',[16,1.2,16],[0,-.65,0],soil);
  box(scene,'bounded-lawn',[16,.16,16],[0,-.01,0],grass);
  for(const [i,x,z,w,d] of [[0,0,-7.88,16,.24],[1,0,7.88,16,.24],[2,-7.88,0,.24,16],[3,7.88,0,.24,16]])
    box(scene,`platform-rim-${i}`,[w,.12,d],[x,.1,z],edge);
  box(scene,'base-camp-pad',[5.2,.04,3.2],[0,.095,0],material(scene,'#294955'));
  for(const [id,x,color] of [['blue',-1.25,'#347e98'],['orange',1.25,'#a76039']])
    box(scene,`base-camp-${id}-lane`,[1.8,.02,2.35],[x,.125,0],material(scene,color));
  const cloudPaint=material(scene,'#d9ecec','#bedde1');cloudPaint.disableLighting=true;cloudPaint.alpha=.72;
  for(const [i,[x,y,z]] of [[-18,-5,10],[18,2,33],[-19,9,56],[18,15,78],[-18,22,101],[19,29,123],[-18,36,145]].entries())
    for(const [j,dx,dy,s] of [[0,-2.1,-.2,.8],[1,0,.25,1.15],[2,2.2,-.15,.72]]){
      const cloud=MeshBuilder.CreateSphere(`cloud-${i}-${j}`,{diameter:4.5,segments:8},scene);
      cloud.position.set(x+dx,y+dy,z);cloud.scaling.set(s*1.45,s*.42,s*.78);cloud.material=cloudPaint;cloud.isPickable=false;
    }
}
function robot(scene,id){
  const main=material(scene,colors[id][0]),dark=material(scene,colors[id][1]),joint=material(scene,'#173449');
  const visor=material(scene,'#10243a','#5ee7ff'),glow=material(scene,'#ffb15c','#ff914d');
  const root=new TransformNode(`${id}-root`,scene),visual=new TransformNode(`${id}-visual`,scene);visual.parent=root;
  const part=(name,size,position,paint,parent=visual)=>{const mesh=box(scene,`${id}-${name}`,size,position,paint,parent);shadows.addShadowCaster(mesh);return mesh;};
  part('torso',[1.15,.95,.72],[0,0,0],main);
  part('chest-panel',[.5,.24,.05],[0,.05,.39],visor);
  part('head',[1.05,.68,.78],[0,.88,0],main);
  part('face-screen',[.74,.3,.05],[0,.9,.415],visor);
  part('left-eye',[.1,.1,.04],[-.19,.92,.45],glow);part('right-eye',[.1,.1,.04],[.19,.92,.45],glow);
  part('backpack',[.72,.75,.34],[0,.08,-.53],dark);
  const socket=MeshBuilder.CreateTorus(`${id}-tether-socket`,{diameter:.35,thickness:.1,tessellation:16},scene);
  socket.position.set(0,.1,-.76);socket.rotation.x=Math.PI/2;socket.material=glow;socket.parent=visual;shadows.addShadowCaster(socket);
  const limb=(name,x,y,size,offset,paint)=>{const pivot=new TransformNode(`${id}-${name}-pivot`,scene);pivot.position.set(x,y,0);pivot.parent=visual;part(name,size,[0,offset,0],paint,pivot);return pivot;};
  return {root,visual,time:0,
    leftArm:limb('left-arm',-.73,.28,[.3,.78,.34],-.34,joint),rightArm:limb('right-arm',.73,.28,[.3,.78,.34],-.34,joint),
    leftLeg:limb('left-leg',-.29,-.42,[.36,.58,.42],-.28,dark),rightLeg:limb('right-leg',.29,-.42,[.36,.58,.42],-.28,dark)};
}
function obstacle(scene,o){
  const zones={grass:['#456852','#527f5a'],construction:['#7b5835','#e7b85f'],industrial:['#39495b','#75889a'],sky:['#647d8e','#c3dce3'],summit:['#846b3b','#e6c45f']};
  const tops={rotatingBeam:'#ef7d57',swingingBeam:'#d97896',fan:'#63cbd0',conveyor:'#667080',fallingPlatform:'#a57c52'};
  const [base,top]=zones[o.zone],w=o.halfExtent.x*2,h=o.halfExtent.y*2,d=o.halfExtent.z*2;
  const paint=material(scene,base);paint.emissiveColor=Color3.FromHexString(base).scale(.12);
  paint.alpha=o.kind==='fan'?.2:o.kind==='conveyor'?.32:1;paint.wireframe=o.kind==='fan';
  const root=box(scene,`obstacle-${o.id}`,[w,h,d],[0,0,0],paint);
  const capPaint=material(scene,tops[o.kind]??top);capPaint.alpha=paint.alpha;
  box(scene,`${o.id}-cap`,[w+.04,.08,d+.04],[0,h/2+.04,0],capPaint,root);
  if(['fan','conveyor','movingPlatform'].includes(o.kind))for(const [i,z] of [-.5,0,.5].entries())
    box(scene,`${o.id}-direction-${i}`,[Math.max(.18,w*.62),.09,Math.max(.1,Math.min(.22,d*.12))],[0,h/2+.1,z*d],material(scene,'#effcff','#8feaff'),root);
  if(o.kind==='rotatingBeam'){
    const hub=MeshBuilder.CreateCylinder(`${o.id}-hub`,{diameter:Math.max(.3,Math.min(w,d)*.45),height:h+.18,tessellation:16},scene);
    hub.material=material(scene,'#26394a','#ff914d');hub.parent=root;
  }
  let warning;
  if(o.kind==='fallingPlatform'){
    warning=box(scene,`${o.id}-warning`,[.42,.42,.12],[0,h/2+.45,0],material(scene,'#fff4d6','#ff914d'),root);
    warning.rotation.z=Math.PI/4;warning.setEnabled(false);
  }
  return {root,warning};
}
function snapshot(scene,msg,delta,now){
  for(const p of msg.players){
    let r=robots.get(p.id);if(!r){r=robot(scene,p.id);robots.set(p.id,r);}
    r.root.position.set(p.position.x,p.position.y,p.position.z);
    const speed=Math.hypot(p.velocity.x,p.velocity.z);
    if(speed>.08){const target=Math.atan2(p.velocity.x,p.velocity.z),angle=r.root.rotation.y;r.root.rotation.y+=Math.atan2(Math.sin(target-angle),Math.cos(target-angle))*(1-Math.exp(-12*delta));}
    r.time+=delta;const swing=reducedMotion?0:Math.sin(r.time*11)*.62*Math.min(speed/3.5,1);
    r.leftArm.rotation.x=swing;r.rightArm.rotation.x=-swing;r.leftLeg.rotation.x=-swing*.72;r.rightLeg.rotation.x=swing*.72;
    r.visual.position.y=reducedMotion?0:Math.sin(r.time*(speed>.1?11:2.2))*(speed>.1?.035:.025);r.visual.scaling.y=p.grounded?1:.94;
  }
  for(const o of msg.obstacles){
    let v=obstacles.get(o.id);if(!v){v=obstacle(scene,o);obstacles.set(o.id,v);}
    const warning=o.kind==='fallingPlatform'&&o.phase==='warning';
    const shake=warning&&!reducedMotion?Math.sin(now*.035)*.045:0;
    v.root.position.set(o.position.x+shake,o.position.y,o.position.z);v.root.rotation.set(o.rotation.x,o.rotation.y,o.rotation.z);
    v.root.setEnabled(o.phase!=='falling'||o.position.y>-12);v.warning?.setEnabled(warning);
  }
  const anchors=msg.players.map(p=>{const r=robots.get(p.id).root;return new Vector3(r.position.x-Math.sin(r.rotation.y)*.76,r.position.y+.1,r.position.z-Math.cos(r.rotation.y)*.76);});
  const points=[],segments=anchors.length===2?1:anchors.length;
  for(let i=0;i<segments;i++)points.push(...tetherPath(anchors[i],anchors[(i+1)%anchors.length],msg.obstacles).slice(i===0?0:1));
  // Fixed vertex count permits updates for every supported roster and ledge route.
  while(points.length<13)points.push(points.at(-1).clone());
  tether=MeshBuilder.CreateLines('energy-tether',{points,updatable:true,instance:tether},scene);
  tether.color=Color3.FromHexString('#ff914d');tether.alpha=.9+msg.tetherTension*.1;
}
function tetherPath(start,end,obstacles){
  for(const o of obstacles){
    if(!['staticPlatform','movingPlatform','fallingPlatform'].includes(o.kind))continue;
    const p=o.position,h=o.halfExtent,top=p.y+h.y,bottom=p.y-h.y;
    const startAnchored=start.y>top&&end.y<bottom,endAnchored=end.y>top&&start.y<bottom;
    if(!startAnchored&&!endAnchored)continue;
    const anchor=startAnchored?start:end,hanging=startAnchored?end:start;
    const inside=v=>Math.abs(v.x-p.x)<=h.x&&Math.abs(v.z-p.z)<=h.z;
    if(Math.abs(anchor.y-(top+1.1))>.2||!inside(anchor)||!inside(hanging))continue;
    const edges=[p.x-h.x-.04,p.x+h.x+.04,p.z-h.z-.04,p.z+h.z+.04];
    const distances=edges.map((edge,i)=>Math.abs((i<2?hanging.x:hanging.z)-edge)),side=distances.indexOf(Math.min(...distances));
    const lower=hanging.clone(),upper=hanging.clone();lower.y=bottom-.04;upper.y=top+.04;
    if(side<2)lower.x=upper.x=edges[side];else lower.z=upper.z=edges[side];
    const route=[hanging,lower,upper,anchor];return startAnchored?route.reverse():route;
  }
  return [start,Vector3.Lerp(start,end,1/3),Vector3.Lerp(start,end,2/3),end];
}
export function configure(settings){
  reducedMotion=settings.reducedMotion;
  if(!camera)return;
  camera.inertia=reducedMotion?0:.82;
  const pointers=camera.inputs.attached.pointers;
  if(pointers){pointers.angularSensibilityX=settings.angularSensibilityX;pointers.angularSensibilityY=settings.angularSensibilityY;}
}
export function settingsPanel(open){
  const dialog=document.getElementById('settings-panel');
  if(open){camera?.detachControl();dialog.showModal();}else{dialog.close();camera?.attachControl(canvas,true);canvas?.focus();}
}
export function resetCamera(){if(camera){camera.alpha=-Math.PI/2-.42;camera.beta=1.18;camera.radius=16.5;}}
export async function fullscreen(){if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}
export function loadPreferences(){try{return localStorage.getItem('linked-up.ui-preferences');}catch{return null;}}
export function savePreferences(value){try{localStorage.setItem('linked-up.ui-preferences',value);}catch{/* Storage is optional in private browsing. */}}
export function prefersReducedMotion(){return window.matchMedia('(prefers-reduced-motion: reduce)').matches;}
export function stop(){bridge=undefined;engine?.dispose();engine=undefined;camera=undefined;shadows=undefined;tether=undefined;canvas=undefined;robots.clear();obstacles.clear();window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',blur);window.removeEventListener('resize',resize);}
