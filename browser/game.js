import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';

let engine, socket, animation, robots = new Map(), obstacles = new Map(), input = new Set(), sequence = 0;
const colors={blue:'#38a6cc',orange:'#e68045',green:'#62a86d',purple:'#9a79c8'};
export function start(canvasId, url, matchId, ticket, dotnet) {
  stop(); const canvas=document.getElementById(canvasId); engine=new Engine(canvas,true); const scene=new Scene(engine); scene.clearColor=Color4.FromHexString('#86c4d4ff');
  const camera=new ArcRotateCamera('camera',-Math.PI/2,1.15,18,new Vector3(0,3,10),scene); camera.attachControl(canvas,true); new HemisphericLight('sun',new Vector3(0,1,0),scene).intensity=.9;
  const floor=MeshBuilder.CreateGround('floor',{width:30,height:180},scene); floor.position.z=76; const ground=new StandardMaterial('ground',scene); ground.diffuseColor=Color3.FromHexString('#527f5a'); floor.material=ground;
  const ws=new WebSocket(url); socket=ws; ws.onopen=()=>ws.send(JSON.stringify({type:'join',matchId,ticket})); ws.onmessage=({data})=>{try{const msg=JSON.parse(data); if(msg.type==='welcome'){dotnet.invokeMethodAsync('GameplayStatus','Connected — waiting for crew.');} if(msg.type==='countdown'){dotnet.invokeMethodAsync('GameplayStatus',msg.seconds ? `Starting in ${msg.seconds}…` : 'Climb!');} if(msg.type==='snapshot') snapshot(scene,msg,dotnet);}catch{dotnet.invokeMethodAsync('GameplayStatus','The game server sent an invalid update.');ws.close();}}; ws.onclose=()=>dotnet.invokeMethodAsync('GameplayStatus','Disconnected from match.');
  const down=e=>{if(['KeyW','KeyA','KeyS','KeyD','Space'].includes(e.code)){input.add(e.code);e.preventDefault();}}; const up=e=>input.delete(e.code); window.addEventListener('keydown',down);window.addEventListener('keyup',up); animation=()=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'input',sequence:++sequence,clientTick:sequence,moveX:(input.has('KeyD')?1:0)-(input.has('KeyA')?1:0),moveZ:(input.has('KeyW')?1:0)-(input.has('KeyS')?1:0),jump:input.has('Space')}));scene.render();}; engine.runRenderLoop(animation); window.addEventListener('resize',()=>engine?.resize());
}
function material(scene,color){const m=new StandardMaterial(color,scene);m.diffuseColor=Color3.FromHexString(color);return m;}
function snapshot(scene,msg,dotnet){for(const p of msg.players){let mesh=robots.get(p.id);if(!mesh){mesh=MeshBuilder.CreateCapsule(p.id,{height:1.8,radius:.42},scene);mesh.material=material(scene,colors[p.id]);robots.set(p.id,mesh);}mesh.position.set(p.position.x,p.position.y,p.position.z);}for(const o of msg.obstacles){let mesh=obstacles.get(o.id);if(!mesh){mesh=MeshBuilder.CreateBox(o.id,{width:o.halfExtent.x*2,height:o.halfExtent.y*2,depth:o.halfExtent.z*2},scene);mesh.material=material(scene,o.zone==='sky'?'#d9ecec':'#4b3831');obstacles.set(o.id,mesh);}mesh.position.set(o.position.x,o.position.y,o.position.z);mesh.rotation.set(o.rotation.x,o.rotation.y,o.rotation.z);}const zone=msg.obstacles.find(o=>o.position.z>0&&o.position.z<35)?.zone??'grass';dotnet.invokeMethodAsync('Snapshot',zone[0].toUpperCase()+zone.slice(1),msg.tetherTension);}
export function stop(){socket?.close();socket=undefined;engine?.dispose();engine=undefined;robots.clear();obstacles.clear();input.clear();sequence=0;}
