import fs from "node:fs";
import path from "node:path";

import { DEPENDENCY_TREE_FILENAME, ODC_PLUGIN_GOAL } from "./constants.ts";

export function buildOwaspCommand(
  mvnPath: string,
  projectRoot: string,
  dataDirectory: string,
  mode: "quick" | "full" = "full",
): string[] {
  const command = [mvnPath];
  if (mode === "full") {
    command.push("clean", "install");
  }
  command.push(
    ODC_PLUGIN_GOAL,
    "-DskipTests",
    "-Dformats=HTML,JSON",
    `-DdataDirectory=${dataDirectory}`,
    "-DautoUpdate=false",
    "-DversionCheckEnabled=false",
    "-DretireJsAnalyzerEnabled=false",
    "-Dodc.outputDirectory=./target/dependency-check",
    "-Ddependency-check.virtualSnapshotsFromReactor=false",
  );
  if (fs.existsSync(path.join(projectRoot, "dependency-check-suppressions.xml"))) {
    command.push("-DsuppressionFiles=./dependency-check-suppressions.xml");
  }
  return command;
}

export function buildDependencyTreeCommand(mvnPath: string): string[] {
  return [
    mvnPath,
    "dependency:tree",
    "-DoutputType=text",
    `-DoutputFile=./target/dependency-check/${DEPENDENCY_TREE_FILENAME}`,
  ];
}
