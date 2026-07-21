import React from "react";
import { Still } from "remotion";
import { Thumbnail } from "./Thumbnail";

export const Root: React.FC = () => (
  <Still id="Thumbnail" component={Thumbnail} width={2048} height={1360} />
);
