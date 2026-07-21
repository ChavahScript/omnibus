import React from "react";
import { Composition } from "remotion";
import { Demo, DEMO_DURATION_FRAMES, FPS } from "./Demo";
import { Descent, DESCENT_DURATION_FRAMES } from "./Descent";
import { Act1Overlay, ACT1_DURATION_FRAMES } from "./Act1Overlay";
import { Act2, ACT2_DURATION_FRAMES } from "./Act2";
import { Act3, ACT3_DURATION_FRAMES } from "./Act3";

export const Root: React.FC = () => (
  <>
    <Composition
      id="Demo"
      component={Demo}
      durationInFrames={DEMO_DURATION_FRAMES}
      fps={FPS}
      width={1920}
      height={1080}
    />
    <Composition
      id="Descent"
      component={Descent}
      durationInFrames={DESCENT_DURATION_FRAMES}
      fps={FPS}
      width={1920}
      height={1080}
    />
    <Composition
      id="Act1Overlay"
      component={Act1Overlay}
      durationInFrames={ACT1_DURATION_FRAMES}
      fps={FPS}
      width={1920}
      height={1080}
    />
    <Composition id="Act2" component={Act2} durationInFrames={ACT2_DURATION_FRAMES} fps={FPS} width={1920} height={1080} />
    <Composition id="Act3" component={Act3} durationInFrames={ACT3_DURATION_FRAMES} fps={FPS} width={1920} height={1080} />
  </>
);
