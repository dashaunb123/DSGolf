import { useState } from "react";
import { App as GolfApp } from "./App";
// Bowling is archived for now — keeping the import commented out so the
// game can be re-enabled by un-commenting two lines.
// import { BowlingApp } from "./bowling/BowlingApp";

type GameId = "menu" | "golf"; // | "bowling";

export function Root() {
  const [game, setGame] = useState<GameId>("menu");

  if (game === "golf") return <GolfApp onExitToMenu={() => setGame("menu")} />;
  // if (game === "bowling") return <BowlingApp onExitToMenu={() => setGame("menu")} />;
  return <Menu onPick={setGame} />;
}

function Menu({ onPick }: { onPick: (g: GameId) => void }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background:
          "radial-gradient(circle at 50% 30%, #2e6cbf 0%, #0a1d3a 60%, #050b18 100%)",
        color: "white",
        fontFamily: "-apple-system, system-ui, sans-serif",
        userSelect: "none",
      }}
    >
      <div style={{ fontSize: 14, letterSpacing: 8, opacity: 0.7, marginBottom: 8 }}>
        WELCOME TO
      </div>
      <div
        style={{
          fontSize: 96,
          fontWeight: 900,
          letterSpacing: 4,
          textShadow: "0 6px 30px rgba(0,0,0,0.55)",
          marginBottom: 8,
        }}
      >
        DS<span style={{ color: "#ffd23b" }}>Sports</span>
      </div>
      <div style={{ fontSize: 16, opacity: 0.75, marginBottom: 48 }}>
        Pick your game
      </div>
      <div style={{ display: "flex", gap: 28, flexWrap: "wrap", justifyContent: "center" }}>
        <GameCard
          title="Golf"
          subtitle="18 holes · solo or LAN multiplayer"
          accent="#5fd35f"
          art={
            <svg viewBox="0 0 100 100" width="120" height="120">
              <circle cx="50" cy="78" r="20" fill="#236b2e" />
              <circle cx="50" cy="78" r="8" fill="#0a0a0a" />
              <path d="M50 78 L50 20" stroke="#ffffff" strokeWidth="3" />
              <path d="M50 22 L78 30 L50 38 Z" fill="#b91d2d" />
              <circle cx="20" cy="82" r="5" fill="#ffffff" />
            </svg>
          }
          onClick={() => onPick("golf")}
        />
      </div>
      <div style={{ marginTop: 48, opacity: 0.5, fontSize: 12 }}>
        more games coming soon
      </div>
    </div>
  );
}

function GameCard({
  title,
  subtitle,
  accent,
  art,
  onClick,
}: {
  title: string;
  subtitle: string;
  accent: string;
  art: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 240,
        padding: 24,
        borderRadius: 18,
        border: `2px solid ${accent}66`,
        background:
          "linear-gradient(160deg, rgba(255,255,255,0.10), rgba(255,255,255,0.02))",
        color: "white",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        boxShadow: "0 16px 40px rgba(0,0,0,0.35)",
        transition: "transform 120ms ease, border-color 120ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-4px)";
        e.currentTarget.style.borderColor = accent;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.borderColor = `${accent}66`;
      }}
    >
      <div>{art}</div>
      <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: 1 }}>{title}</div>
      <div style={{ fontSize: 13, opacity: 0.75 }}>{subtitle}</div>
      <div
        style={{
          marginTop: 6,
          padding: "6px 14px",
          borderRadius: 999,
          background: accent,
          color: "#1a1a1a",
          fontWeight: 800,
          fontSize: 13,
          letterSpacing: 1,
        }}
      >
        PLAY
      </div>
    </button>
  );
}
