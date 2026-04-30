import { ImageResponse } from "next/og"

export const alt = "VoiceClaw — Voice for the agent you already trust."
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

const PAPER = "#F1E8DA"
const PAPER_STRONG = "#E8DDCD"
const PANEL = "#FDF9F1"
const INK = "#191511"
const MUTED = "#665F58"
const ACCENT = "#B4492F"
const LINE = "rgba(25, 21, 17, 0.2)"

export default async function OpenGraphImage() {
  const [fraunces, jetbrains] = await Promise.all([
    loadGoogleFont("Fraunces", 600),
    loadGoogleFont("JetBrains Mono", 500),
  ])

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: PAPER,
          backgroundImage: `linear-gradient(135deg, ${PAPER} 0%, ${PAPER_STRONG} 100%)`,
          color: INK,
          padding: 80,
          fontFamily: "Fraunces",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage: `linear-gradient(to right, rgba(25,21,17,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(25,21,17,0.06) 1px, transparent 1px)`,
            backgroundSize: "112px 112px",
            opacity: 0.7,
          }}
        />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            fontFamily: "JetBrains Mono",
            fontSize: 22,
            color: MUTED,
            letterSpacing: 2,
            textTransform: "uppercase",
            zIndex: 1,
          }}
        >
          <Mark />
          <span>Open source voice layer</span>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            justifyContent: "center",
            zIndex: 1,
          }}
        >
          <div
            style={{
              fontFamily: "Fraunces",
              fontSize: 168,
              lineHeight: 0.95,
              color: INK,
              letterSpacing: -2,
            }}
          >
            VoiceClaw
          </div>
          <div
            style={{
              marginTop: 28,
              fontFamily: "Fraunces",
              fontSize: 64,
              lineHeight: 1.05,
              color: INK,
              maxWidth: 980,
            }}
          >
            Voice for the agent you already trust.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingTop: 28,
            borderTop: `1px solid ${LINE}`,
            zIndex: 1,
          }}
        >
          <div
            style={{
              fontFamily: "JetBrains Mono",
              fontSize: 22,
              color: MUTED,
              letterSpacing: 1.5,
            }}
          >
            iPhone · Mac · BYO agent
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "10px 18px",
              border: `1px solid ${LINE}`,
              background: PANEL,
              borderRadius: 8,
              fontFamily: "JetBrains Mono",
              fontSize: 22,
              color: INK,
              letterSpacing: 1.5,
            }}
          >
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: 999,
                background: ACCENT,
              }}
            />
            voiceclaw.io
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Fraunces", data: fraunces, style: "normal", weight: 600 },
        { name: "JetBrains Mono", data: jetbrains, style: "normal", weight: 500 },
      ],
    },
  )
}

async function loadGoogleFont(family: string, weight: number): Promise<ArrayBuffer> {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`
  const cssResponse = await fetch(cssUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_6_8) AppleWebKit/534.50 (KHTML, like Gecko) Version/5.1 Safari/534.50",
    },
  })
  if (!cssResponse.ok) {
    throw new Error(`Failed to fetch font CSS for ${family}: ${cssResponse.status}`)
  }
  const css = await cssResponse.text()
  const match = css.match(/src:\s*url\((https:\/\/[^)]+)\)/)
  if (!match) {
    throw new Error(`Could not find font URL for ${family}`)
  }
  const fontResponse = await fetch(match[1])
  if (!fontResponse.ok) {
    throw new Error(`Failed to fetch font file for ${family}: ${fontResponse.status}`)
  }
  return fontResponse.arrayBuffer()
}

function Mark() {
  return (
    <svg width="40" height="40" viewBox="0 0 64 64" fill="none">
      <path d="M20 10 H14 V54 H20" stroke={INK} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 10 L27 17" stroke={INK} strokeWidth="4" strokeLinecap="round" />
      <path d="M20 54 L27 47" stroke={INK} strokeWidth="4" strokeLinecap="round" />
      <path d="M44 10 H50 V54 H44" stroke={INK} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M44 10 L37 17" stroke={INK} strokeWidth="4" strokeLinecap="round" />
      <path d="M44 54 L37 47" stroke={INK} strokeWidth="4" strokeLinecap="round" />
      <path d="M29 40 V24" stroke={ACCENT} strokeWidth="4.5" strokeLinecap="round" />
      <path d="M35 46 V18" stroke={INK} strokeWidth="4.5" strokeLinecap="round" />
      <path d="M41 37 V27" stroke={INK} strokeWidth="4.5" strokeLinecap="round" />
    </svg>
  )
}
