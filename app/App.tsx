/**
 * Loom — native app. Same daemon API as the CLI/TUI/web app:
 * pair over the tailnet, watch the board, drive the shared thread, and see
 * exactly which code each prompt changed.
 */

import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { SafeAreaView, View } from "react-native";
import { loadCreds, setUnauthorizedHandler, type Creds, type Project } from "./src/api";
import { enablePush } from "./src/push";
import { BoardScreen, PairScreen, ProjectScreen, unpair } from "./src/screens";
import { T } from "./src/theme";

type Route = { name: "pair" } | { name: "board" } | { name: "project"; project: Project };

export default function App() {
  const [creds, setCreds] = useState<Creds | null>(null);
  const [route, setRoute] = useState<Route>({ name: "pair" });
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    void loadCreds().then((saved) => {
      if (saved) {
        setCreds(saved);
        setRoute({ name: "board" });
      }
      setBooted(true);
    });
  }, []);

  // Register for pushes whenever we have credentials (idempotent).
  useEffect(() => {
    if (creds) void enablePush(creds);
  }, [creds]);

  // A revoked/expired token anywhere sends us back to the pair screen.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCreds(null);
      setRoute({ name: "pair" });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg }}>
      <StatusBar style="light" />
      {!booted ? (
        <View style={{ flex: 1, backgroundColor: T.bg }} />
      ) : route.name === "pair" || !creds ? (
        <PairScreen
          onPaired={(c) => {
            setCreds(c);
            setRoute({ name: "board" });
          }}
        />
      ) : route.name === "board" ? (
        <BoardScreen
          creds={creds}
          onOpen={(project) => setRoute({ name: "project", project })}
          onUnpair={() => {
            void unpair();
            setCreds(null);
            setRoute({ name: "pair" });
          }}
        />
      ) : (
        <ProjectScreen
          creds={creds}
          project={route.project}
          onBack={() => setRoute({ name: "board" })}
        />
      )}
    </SafeAreaView>
  );
}
