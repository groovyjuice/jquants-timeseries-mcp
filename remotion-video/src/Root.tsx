import React from 'react';
import {Composition} from 'remotion';
import {TestVideo, type VideoProps} from './Video';
import {scenes as defaultScenes} from './scenes';

export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="TestVideo"
        component={TestVideo}
        durationInFrames={900}
        fps={30}
        width={1920}
        height={1080}
        calculateMetadata={({props}) => {
          const videoProps = props as VideoProps;
          const scenes = videoProps.scenes ?? defaultScenes;
          const durationInFrames = Math.max(
            1,
            ...scenes.map((scene) => scene.from + scene.duration),
          );

          return {durationInFrames};
        }}
      />
      <Composition
        id="SmokeTest"
        component={TestVideo}
        durationInFrames={30}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
