import React from 'react';
import {Composition} from 'remotion';
import {TestVideo} from './Video';

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
