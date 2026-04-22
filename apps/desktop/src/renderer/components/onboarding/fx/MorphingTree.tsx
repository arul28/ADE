import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "./useReducedMotion";

export type MorphingTreeHandle = {
  growBranch(name: string): void;
  pruneBranch(name: string): void;
  highlightBranch(name: string | null): void;
};

export type MorphingTreeProps = {
  size?: number;
  primaryLabel?: string;
};

type Branch = { name: string };

function angleFor(index: number, total: number): number {
  // Distribute branches across a -60°..+60° arc around horizontal.
  if (total <= 1) return 0;
  const min = -60;
  const max = 60;
  return min + ((max - min) * index) / (total - 1);
}

export const MorphingTree = forwardRef<MorphingTreeHandle, MorphingTreeProps>(function MorphingTree(
  { size = 320, primaryLabel = "primary" },
  ref,
) {
  const reduced = useReducedMotion();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [pruning, setPruning] = useState<Set<string>>(new Set());

  const addBranch = useCallback((name: string) => {
    setBranches((prev) => {
      if (prev.some((b) => b.name === name)) return prev;
      return [...prev, { name }];
    });
  }, []);

  const removeBranchImmediate = useCallback((name: string) => {
    setBranches((prev) => prev.filter((b) => b.name !== name));
    setPruning((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  }, []);

  const prune = useCallback(
    (name: string) => {
      if (reduced) {
        removeBranchImmediate(name);
        return;
      }
      setPruning((prev) => {
        const next = new Set(prev);
        next.add(name);
        return next;
      });
      window.setTimeout(() => {
        removeBranchImmediate(name);
      }, 600);
    },
    [reduced, removeBranchImmediate],
  );

  useImperativeHandle(
    ref,
    (): MorphingTreeHandle => ({
      growBranch(name: string) {
        addBranch(name);
      },
      pruneBranch(name: string) {
        prune(name);
      },
      highlightBranch(name: string | null) {
        setHighlight(name);
      },
    }),
    [addBranch, prune],
  );

  const cx = size / 2;
  const topY = size * 0.08;
  const trunkStartY = size * 0.18;
  const trunkMidY = size * 0.52;
  const trunkEndY = size * 0.92;
  const branchLen = size * 0.38;

  const visibleBranches = useMemo(
    () => branches.map((b, i) => ({ ...b, angle: angleFor(i, branches.length) })),
    [branches],
  );

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Branch tree with primary ${primaryLabel}`}
      style={{ display: "block" }}
    >
      {/* Trunk */}
      <line
        x1={cx}
        y1={trunkStartY}
        x2={cx}
        y2={trunkEndY}
        stroke="var(--color-fg)"
        strokeOpacity={0.85}
        strokeWidth={2}
        strokeLinecap="round"
      />
      {/* Primary label */}
      <circle cx={cx} cy={topY} r={10} fill="var(--color-accent)" />
      <text
        x={cx}
        y={topY - 14}
        textAnchor="middle"
        fontSize={12}
        fontFamily="var(--font-mono)"
        fill="var(--color-fg)"
      >
        {primaryLabel}
      </text>
      {/* Branches */}
      <AnimatePresence>
        {visibleBranches.map((branch) => {
          const isPruning = pruning.has(branch.name);
          const rad = (branch.angle * Math.PI) / 180;
          // Direction: alternate left/right by sign of angle.
          const side = branch.angle < 0 ? -1 : branch.angle === 0 ? 1 : 1;
          // Endpoint offset from trunk midpoint.
          const endX = cx + Math.sin(rad) * branchLen * Math.sign(side || 1) + (branch.angle === 0 ? 0 : 0);
          // Simpler: compute endpoint using angle directly from trunk mid to the right.
          const dirX = Math.sign(branch.angle || 1);
          const absAngle = Math.abs(branch.angle);
          const dx = Math.sin((absAngle * Math.PI) / 180) * branchLen;
          const dy = -Math.cos((absAngle * Math.PI) / 180) * branchLen * 0.4;
          const ex = cx + dx * dirX;
          const ey = trunkMidY + dy;
          // Control point for quadratic bezier: slight curve.
          const ctrlX = cx + dx * dirX * 0.4;
          const ctrlY = trunkMidY + dy * 0.2;
          const d = `M ${cx} ${trunkMidY} Q ${ctrlX} ${ctrlY} ${ex} ${ey}`;
          const isHighlighted = highlight === branch.name;
          const anyHighlighted = highlight !== null;
          const dim = anyHighlighted && !isHighlighted;
          const stroke = isHighlighted ? "var(--color-accent)" : "var(--color-fg)";
          const strokeOpacity = dim ? 0.25 : isHighlighted ? 1 : 0.8;
          // Avoid unused var warnings from exploratory calc:
          void endX;

          const pathLength = reduced ? 1 : isPruning ? 0 : 1;

          return (
            <motion.g key={branch.name}>
              <motion.path
                d={d}
                fill="none"
                stroke={stroke}
                strokeOpacity={strokeOpacity}
                strokeWidth={2}
                strokeLinecap="round"
                initial={reduced ? { pathLength: 1 } : { pathLength: 0 }}
                animate={{ pathLength }}
                transition={
                  reduced
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 120, damping: 20, duration: 0.6 }
                }
              />
              <motion.circle
                cx={ex}
                cy={ey}
                r={6}
                fill={isHighlighted ? "var(--color-accent)" : "var(--color-card)"}
                stroke={stroke}
                strokeOpacity={strokeOpacity}
                strokeWidth={1.5}
                initial={reduced ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.5 }}
                animate={{ opacity: isPruning ? 0 : 1, scale: isPruning ? 0.5 : 1 }}
                transition={reduced ? { duration: 0 } : { delay: 0.4, duration: 0.3 }}
              />
              <motion.text
                x={ex + dirX * 10}
                y={ey + 4}
                textAnchor={dirX < 0 ? "end" : "start"}
                fontSize={11}
                fontFamily="var(--font-mono)"
                fill="var(--color-fg)"
                fillOpacity={strokeOpacity}
                initial={reduced ? { opacity: 1 } : { opacity: 0 }}
                animate={{ opacity: isPruning ? 0 : strokeOpacity }}
                transition={reduced ? { duration: 0 } : { delay: 0.45, duration: 0.25 }}
              >
                {branch.name}
              </motion.text>
            </motion.g>
          );
        })}
      </AnimatePresence>
    </svg>
  );
});
