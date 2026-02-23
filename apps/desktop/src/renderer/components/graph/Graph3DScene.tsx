import React, { useCallback, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Line, OrbitControls, Sphere, Text } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import { motion, AnimatePresence } from "motion/react";
import * as THREE from "three";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Graph3DNode {
  id: string;
  label: string;
  x: number;
  y: number;
  status?: "active" | "idle" | "conflict" | "merged" | "primary";
  type?: "primary" | "worktree" | "attached";
}

export interface Graph3DEdge {
  source: string;
  target: string;
  type?: "topology" | "stack" | "risk";
}

export interface Graph3DSceneProps {
  nodes: Graph3DNode[];
  edges: Graph3DEdge[];
  onNodeClick?: (nodeId: string) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NODE_COLORS: Record<string, string> = {
  primary: "#06d6a0",
  active: "#22c55e",
  idle: "#71717a",
  conflict: "#ef4444",
  merged: "#10b981",
};

const EDGE_COLORS: Record<string, string> = {
  topology: "#27272a",
  stack: "#f59e0b",
  risk: "#ef4444",
};

const SCALE = 2;
const IDLE_TIMEOUT_MS = 10_000;
const AUTO_ROTATE_SPEED = 0.4;
const MAX_EDGE_PARTICLES = 20;
const OVERVIEW_POS = new THREE.Vector3(0, 0, 50);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeColor(status: string | undefined): string {
  return NODE_COLORS[status ?? "idle"] ?? NODE_COLORS.idle;
}

function edgeColor(type: string | undefined): string {
  return EDGE_COLORS[type ?? "topology"] ?? EDGE_COLORS.topology;
}

type Vec3 = [number, number, number];

function nodePosition(node: Graph3DNode): Vec3 {
  return [node.x * SCALE, node.y * SCALE, 0];
}

// ---------------------------------------------------------------------------
// CameraController - smooth fly-to on focus
// ---------------------------------------------------------------------------

function CameraController({
  targetPos,
  shouldFly,
}: {
  targetPos: Vec3 | null;
  shouldFly: boolean;
}) {
  const { camera } = useThree();

  useFrame(() => {
    if (!shouldFly || !targetPos) {
      // Return to overview when not focused
      camera.position.lerp(OVERVIEW_POS, 0.02);
      camera.lookAt(0, 0, 0);
      return;
    }
    const target = new THREE.Vector3(
      targetPos[0],
      targetPos[1],
      targetPos[2] + 15,
    );
    camera.position.lerp(target, 0.03);
    camera.lookAt(targetPos[0], targetPos[1], targetPos[2]);
  });

  return null;
}

// ---------------------------------------------------------------------------
// EdgeParticle - animated sphere along edge
// ---------------------------------------------------------------------------

function EdgeParticle({
  start,
  end,
  speed = 2,
}: {
  start: Vec3;
  end: Vec3;
  speed?: number;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const progress = useRef(Math.random());

  useFrame((_, delta) => {
    if (!meshRef.current) return;
    progress.current = (progress.current + delta * speed * 0.1) % 1;
    const t = progress.current;
    meshRef.current.position.set(
      start[0] + (end[0] - start[0]) * t,
      start[1] + (end[1] - start[1]) * t,
      start[2] + (end[2] - start[2]) * t,
    );
  });

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[0.08, 8, 8]} />
      <meshBasicMaterial color="#06d6a0" transparent opacity={0.6} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// GraphNodeMesh
// ---------------------------------------------------------------------------

interface GraphNodeMeshProps {
  node: Graph3DNode;
  onClick?: (nodeId: string) => void;
  isFocused?: boolean;
}

function GraphNodeMesh({ node, onClick, isFocused }: GraphNodeMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const targetScale = useRef(1);

  const pos = useMemo<Vec3>(() => nodePosition(node), [node]);
  const color = useMemo(() => nodeColor(node.status), [node.status]);

  const material = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color,
        emissive: new THREE.Color(color),
        emissiveIntensity: isFocused ? 0.5 : 0.2,
        roughness: 0.3,
        metalness: 0.7,
      }),
    [color, isFocused],
  );

  // Smooth scale spring via useFrame
  useFrame(() => {
    if (!meshRef.current) return;
    targetScale.current = hovered || isFocused ? 1.3 : 1.0;
    const s = meshRef.current.scale.x;
    const next = THREE.MathUtils.lerp(s, targetScale.current, 0.15);
    meshRef.current.scale.setScalar(next);
  });

  const handlePointerOver = useCallback(() => setHovered(true), []);
  const handlePointerOut = useCallback(() => setHovered(false), []);
  const handleClick = useCallback(
    (e: THREE.Event & { stopPropagation: () => void }) => {
      e.stopPropagation();
      onClick?.(node.id);
    },
    [onClick, node.id],
  );

  return (
    <group position={pos}>
      <Sphere
        ref={meshRef}
        args={[0.6, 32, 32]}
        material={material}
        onPointerOver={handlePointerOver}
        onPointerOut={handlePointerOut}
        onClick={handleClick}
      />
      {/* Glow ring on hover */}
      {(hovered || isFocused) && (
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.75, 0.95, 48]} />
          <meshBasicMaterial
            color={color}
            transparent
            opacity={0.35}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
      {/* Label */}
      <Text
        position={[0, -1.2, 0]}
        fontSize={0.35}
        color="#a1a1aa"
        anchorX="center"
        anchorY="top"
      >
        {node.label}
      </Text>
    </group>
  );
}

// ---------------------------------------------------------------------------
// GraphEdgeLine
// ---------------------------------------------------------------------------

interface GraphEdgeLineProps {
  edge: Graph3DEdge;
  positionMap: Map<string, Vec3>;
}

function GraphEdgeLine({ edge, positionMap }: GraphEdgeLineProps) {
  const sourcePos = positionMap.get(edge.source);
  const targetPos = positionMap.get(edge.target);
  if (!sourcePos || !targetPos) return null;

  const color = edgeColor(edge.type);
  const isDashed = edge.type === "risk";
  const isStack = edge.type === "stack";

  return (
    <Line
      points={[sourcePos, targetPos]}
      color={color}
      lineWidth={isStack ? 2 : 1.5}
      dashed={isDashed}
      dashSize={isDashed ? 0.3 : undefined}
      gapSize={isDashed ? 0.2 : undefined}
      dashScale={isDashed ? 1 : undefined}
    />
  );
}

// ---------------------------------------------------------------------------
// AutoRotateController
// ---------------------------------------------------------------------------

interface AutoRotateControllerProps {
  controlsRef: React.RefObject<React.ComponentRef<typeof OrbitControls> | null>;
  disabled?: boolean;
}

function AutoRotateController({
  controlsRef,
  disabled,
}: AutoRotateControllerProps) {
  const lastInteraction = useRef(Date.now());

  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    // Cast to access OrbitControls-specific properties
    const ctrl = controls as unknown as {
      autoRotate: boolean;
      autoRotateSpeed: number;
      update: () => void;
    };

    if (disabled) {
      ctrl.autoRotate = false;
      ctrl.update();
      return;
    }

    const idle = Date.now() - lastInteraction.current > IDLE_TIMEOUT_MS;
    ctrl.autoRotate = idle;
    ctrl.autoRotateSpeed = AUTO_ROTATE_SPEED;
    ctrl.update();
  });

  // Reset idle timer on pointer events (captured at the canvas level via this group)
  const handleInteraction = useCallback(() => {
    lastInteraction.current = Date.now();
  }, []);

  return (
    <group
      onPointerDown={handleInteraction}
      onPointerMove={handleInteraction}
      onWheel={handleInteraction}
    >
      {/* Invisible large plane to catch all pointer events */}
      <mesh visible={false}>
        <planeGeometry args={[200, 200]} />
        <meshBasicMaterial />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------------------
// SceneContent (everything inside the Canvas)
// ---------------------------------------------------------------------------

interface SceneContentProps {
  nodes: Graph3DNode[];
  edges: Graph3DEdge[];
  focusedNodeId: string | null;
  onNodeClick: (nodeId: string) => void;
  onBackgroundClick: () => void;
  positionMapRef: React.MutableRefObject<Map<string, Vec3>>;
}

function SceneContent({
  nodes,
  edges,
  focusedNodeId,
  onNodeClick,
  onBackgroundClick,
  positionMapRef,
}: SceneContentProps) {
  const controlsRef = useRef<React.ComponentRef<typeof OrbitControls>>(null);

  const positionMap = useMemo(() => {
    const map = new Map<string, Vec3>();
    for (const node of nodes) {
      map.set(node.id, nodePosition(node));
    }
    // Sync into parent ref for overlay minimap
    positionMapRef.current = map;
    return map;
  }, [nodes, positionMapRef]);

  const focusedPos = focusedNodeId
    ? positionMap.get(focusedNodeId) ?? null
    : null;

  // Edge particles (limited to MAX_EDGE_PARTICLES)
  const particleEdges = useMemo(() => {
    return edges.slice(0, MAX_EDGE_PARTICLES);
  }, [edges]);

  return (
    <>
      {/* Environment */}
      <fog attach="fog" args={["#0f0f11", 40, 80]} />

      {/* Lighting */}
      <ambientLight intensity={0.4} />
      <directionalLight position={[10, 15, 10]} intensity={0.8} />
      <pointLight position={[0, 0, 5]} intensity={0.15} color="#06d6a0" />

      {/* Controls */}
      <OrbitControls
        ref={controlsRef}
        enableDamping
        dampingFactor={0.05}
        minDistance={5}
        maxDistance={120}
      />

      {/* Camera fly-to controller */}
      <CameraController
        targetPos={focusedPos}
        shouldFly={focusedNodeId !== null}
      />

      {/* Auto-rotate logic */}
      <AutoRotateController
        controlsRef={controlsRef}
        disabled={focusedNodeId !== null}
      />

      {/* Edges (render behind nodes) */}
      {edges.map((edge) => (
        <GraphEdgeLine
          key={`${edge.source}-${edge.target}-${edge.type ?? "topology"}`}
          edge={edge}
          positionMap={positionMap}
        />
      ))}

      {/* Edge Particles */}
      {particleEdges.map((edge) => {
        const sp = positionMap.get(edge.source);
        const tp = positionMap.get(edge.target);
        if (!sp || !tp) return null;
        return (
          <EdgeParticle
            key={`particle-${edge.source}-${edge.target}`}
            start={sp}
            end={tp}
          />
        );
      })}

      {/* Nodes */}
      {nodes.map((node) => (
        <GraphNodeMesh
          key={node.id}
          node={node}
          onClick={onNodeClick}
          isFocused={focusedNodeId === node.id}
        />
      ))}

      {/* Subtle ground reference grid */}
      <gridHelper
        args={[60, 30, "#1a1a1e", "#141416"]}
        position={[0, -8, 0]}
        rotation={[0, 0, 0]}
      />

      {/* Background click catcher */}
      <mesh
        position={[0, 0, -5]}
        onClick={onBackgroundClick}
        visible={false}
      >
        <planeGeometry args={[200, 200]} />
        <meshBasicMaterial />
      </mesh>

      {/* Post-processing pipeline */}
      <EffectComposer>
        <Bloom
          intensity={0.4}
          luminanceThreshold={0.8}
          luminanceSmoothing={0.6}
        />
        <Vignette darkness={0.3} offset={0.3} />
      </EffectComposer>
    </>
  );
}

// ---------------------------------------------------------------------------
// Graph3DScene (main export)
// ---------------------------------------------------------------------------

export function Graph3DScene({
  nodes,
  edges,
  onNodeClick,
  className,
}: Graph3DSceneProps) {
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const positionMapRef = useRef<Map<string, Vec3>>(new Map());

  const focusedNode = useMemo(
    () => nodes.find((n) => n.id === focusedNodeId) ?? null,
    [nodes, focusedNodeId],
  );

  // When search matches a node, fly to it
  const handleSearch = useCallback(
    (query: string) => {
      setSearchQuery(query);
      if (!query.trim()) return;
      const q = query.toLowerCase();
      const match = nodes.find((n) => n.label.toLowerCase().includes(q));
      if (match) {
        setFocusedNodeId(match.id);
      }
    },
    [nodes],
  );

  const handleNodeClick = useCallback((nodeId: string) => {
    setFocusedNodeId(nodeId);
  }, []);

  const handleBackgroundClick = useCallback(() => {
    setFocusedNodeId(null);
  }, []);

  return (
    <div className={`relative w-full h-full ${className ?? ""}`}>
      {/* R3F Canvas */}
      <Canvas
        camera={{ position: [0, 0, 50], fov: 60 }}
        gl={{
          antialias: true,
          alpha: true,
          toneMapping: THREE.LinearToneMapping,
        }}
        style={{ background: "transparent" }}
      >
        <SceneContent
          nodes={nodes}
          edges={edges}
          focusedNodeId={focusedNodeId}
          onNodeClick={handleNodeClick}
          onBackgroundClick={handleBackgroundClick}
          positionMapRef={positionMapRef}
        />
      </Canvas>

      {/* Overlay UI */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3">
        {/* Top row */}
        <div className="flex items-start justify-between gap-2">
          {/* Search */}
          <div className="pointer-events-auto">
            <input
              type="text"
              placeholder="Find node..."
              className="w-[200px] h-8 rounded-lg bg-card/60 backdrop-blur-sm border border-border/20 px-3 text-xs text-fg placeholder:text-muted-fg/50 outline-none focus:border-accent/40"
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
            />
          </div>

          <div className="flex items-start gap-2">
            {/* Node count */}
            <span className="pointer-events-auto text-[11px] font-mono text-muted-fg/70 bg-surface-recessed/80 backdrop-blur-sm rounded px-2 py-0.5">
              {nodes.length} node{nodes.length !== 1 ? "s" : ""}
            </span>

            {/* Minimap */}
            <div className="pointer-events-auto w-[120px] h-[80px] rounded-lg bg-card/60 backdrop-blur-sm border border-border/20 overflow-hidden">
              <svg viewBox="-20 -20 40 40" className="w-full h-full">
                {edges.map((edge) => {
                  const sp = positionMapRef.current.get(edge.source);
                  const tp = positionMapRef.current.get(edge.target);
                  if (!sp || !tp) return null;
                  return (
                    <line
                      key={`mm-${edge.source}-${edge.target}`}
                      x1={sp[0] / SCALE}
                      y1={sp[1] / SCALE}
                      x2={tp[0] / SCALE}
                      y2={tp[1] / SCALE}
                      stroke="rgba(113,113,122,0.3)"
                      strokeWidth={0.3}
                    />
                  );
                })}
                {nodes.map((node) => (
                  <circle
                    key={`mm-${node.id}`}
                    cx={node.x}
                    cy={node.y}
                    r={focusedNodeId === node.id ? 1.2 : 0.8}
                    fill={nodeColor(node.status)}
                    opacity={0.7}
                  />
                ))}
              </svg>
            </div>
          </div>
        </div>

        {/* Bottom row */}
        <div className="flex justify-end">
          <span className="text-[10px] text-muted-fg/50 select-none">
            Scroll to zoom &middot; Drag to orbit &middot; Click node for details
          </span>
        </div>
      </div>

      {/* Node Detail Panel */}
      <AnimatePresence>
        {focusedNodeId && focusedNode && (
          <motion.div
            initial={{ x: 300, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 300, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="pointer-events-auto absolute top-0 right-0 bottom-0 w-[280px] bg-surface-recessed backdrop-blur-xl border-l border-border/20 p-4 overflow-auto"
          >
            <button
              onClick={() => setFocusedNodeId(null)}
              className="text-xs text-muted-fg hover:text-fg mb-3"
            >
              &larr; Back to overview
            </button>
            <h3 className="text-sm font-semibold text-fg">
              {focusedNode.label}
            </h3>
            <div className="mt-2 text-xs text-muted-fg space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-muted-fg/60">Status:</span>
                <span
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                  style={{
                    backgroundColor: `${nodeColor(focusedNode.status)}20`,
                    color: nodeColor(focusedNode.status),
                  }}
                >
                  {focusedNode.status ?? "idle"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-fg/60">Type:</span>
                <span>{focusedNode.type ?? "worktree"}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-fg/60">Position:</span>
                <span className="font-mono text-[10px]">
                  ({focusedNode.x.toFixed(1)}, {focusedNode.y.toFixed(1)})
                </span>
              </div>
            </div>
            <button
              onClick={() => onNodeClick?.(focusedNodeId)}
              className="mt-4 w-full h-8 rounded-lg bg-accent text-accent-fg text-xs font-medium hover:brightness-110 transition-all"
            >
              Open Lane
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
