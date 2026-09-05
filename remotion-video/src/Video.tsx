import React from 'react';
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  useCurrentFrame,
} from 'remotion';
import {scenes} from './scenes';

const Avatar: React.FC<{emotion: 'normal' | 'surprise' | 'serious'}> = ({emotion}) => {
  const frame = useCurrentFrame();
  const bob = Math.sin(frame / 8) * 6;
  const talking = frame % 10 < 5;
  const mouth = talking ? '●' : '―';
  const eyes = emotion === 'surprise' ? '◉ ◉' : emotion === 'serious' ? '• •' : '◕ ◕';
  return (
    <div
      style={{
        position: 'absolute',
        right: 90,
        bottom: 120,
        width: 320,
        height: 320,
        borderRadius: 999,
        background: 'rgba(255,255,255,0.94)',
        border: '10px solid rgba(0,0,0,0.12)',
        transform: `translateY(${bob}px)`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'sans-serif',
        boxShadow: '0 20px 60px rgba(0,0,0,0.22)',
      }}
    >
      <div style={{fontSize: 70, letterSpacing: 28, marginLeft: 28}}>{eyes}</div>
      <div style={{fontSize: 72, marginTop: 20}}>{mouth}</div>
      <div style={{fontSize: 30, marginTop: 20}}>Vキャラ仮</div>
    </div>
  );
};

const SceneCard: React.FC<{title: string; body: string; emotion: 'normal' | 'surprise' | 'serious'}> = ({title, body, emotion}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill
      style={{
        background: 'linear-gradient(135deg, #101624 0%, #24324d 100%)',
        color: 'white',
        fontFamily: 'sans-serif',
        padding: 120,
      }}
    >
      <div style={{opacity, maxWidth: 1200}}>
        <div style={{fontSize: 94, fontWeight: 800, lineHeight: 1.1}}>{title}</div>
        <div style={{fontSize: 50, marginTop: 48, lineHeight: 1.5}}>{body}</div>
      </div>
      <Avatar emotion={emotion} />
      <div
        style={{
          position: 'absolute',
          left: 120,
          right: 120,
          bottom: 55,
          fontSize: 34,
          padding: '20px 30px',
          borderRadius: 20,
          background: 'rgba(0,0,0,0.55)',
          textAlign: 'center',
        }}
      >
        {body}
      </div>
    </AbsoluteFill>
  );
};

export const TestVideo: React.FC = () => {
  return (
    <AbsoluteFill>
      {scenes.map((scene, i) => (
        <Sequence key={i} from={scene.from} durationInFrames={scene.duration}>
          <SceneCard title={scene.title} body={scene.body} emotion={scene.emotion} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
