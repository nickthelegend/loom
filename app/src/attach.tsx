/**
 * Attach a picture to a message from the phone: a photo from the camera, or an
 * image you copied. It uploads as the desktop's attachments do (POST
 * /attachments, saved under .loom/attachments) and goes out as the same
 * "[image] <path>" line at the top of the message, so every agent reads it
 * the same way. No extra packages: the camera module is the one pairing
 * already uses, and the clipboard module can hand over an image.
 */

import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { useRef, useState } from "react";
import { ActivityIndicator, Alert, Image, Modal, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { uploadAttachment, type Creds } from "./api";
import { T, radii } from "./theme";

export interface Attached {
  id: number;
  name: string;
  /** For the chip's thumbnail. */
  uri: string;
  path?: string;
  uploading: boolean;
}

let seq = 0;

export function useAttachments(creds: Creds, projectId: string, onError: (msg: string) => void) {
  const [items, setItems] = useState<Attached[]>([]);
  const add = (dataUrl: string, name: string) => {
    const rec: Attached = { id: ++seq, name, uri: dataUrl, uploading: true };
    setItems((xs) => [...xs, rec]);
    void uploadAttachment(creds, projectId, name, dataUrl)
      .then((r) => setItems((xs) => xs.map((x) => (x.id === rec.id ? { ...x, path: r.path, uploading: false } : x))))
      .catch((e) => {
        setItems((xs) => xs.filter((x) => x.id !== rec.id));
        onError(`couldn't attach that: ${e instanceof Error ? e.message : String(e)}`);
      });
  };
  return {
    items,
    add,
    remove: (id: number) => setItems((xs) => xs.filter((x) => x.id !== id)),
    clear: () => setItems([]),
    uploading: items.some((x) => x.uploading),
    /** The lines that lead the message, as the desktop writes them. */
    refs: () => items.filter((x) => x.path).map((x) => `[image] ${x.path}`),
  };
}

/** The "+" beside the message box: take a photo, or paste a copied image. */
export function AttachButton(props: { onAdd: (dataUrl: string, name: string) => void; onError: (msg: string) => void }) {
  const [camera, setCamera] = useState(false);
  const pick = async () => {
    const canPaste = await Clipboard.hasImageAsync().catch(() => false);
    Alert.alert("Attach", undefined, [
      { text: "Take a photo", onPress: () => setCamera(true) },
      ...(canPaste
        ? [{
            text: "Paste the copied image",
            onPress: () =>
              void Clipboard.getImageAsync({ format: "jpeg", jpegQuality: 0.7 })
                .then((img) => (img?.data ? props.onAdd(img.data.startsWith("data:") ? img.data : `data:image/jpeg;base64,${img.data}`, "pasted-image.jpg") : props.onError("nothing to paste")))
                .catch((e) => props.onError(String(e instanceof Error ? e.message : e))),
          }]
        : []),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };
  return (
    <>
      <TouchableOpacity onPress={() => void pick()} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Attach a photo or a copied image"
        style={{ width: 34, height: 34, borderRadius: radii.key, borderWidth: 1, borderColor: T.line, backgroundColor: T.raised, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: T.dim, fontSize: 18, lineHeight: 20 }}>＋</Text>
      </TouchableOpacity>
      <CameraSheet visible={camera} onClose={() => setCamera(false)} onShot={(d) => { setCamera(false); props.onAdd(d, `photo-${Date.now()}.jpg`); }} onError={props.onError} />
    </>
  );
}

function CameraSheet(props: { visible: boolean; onClose: () => void; onShot: (dataUrl: string) => void; onError: (msg: string) => void }) {
  const insets = useSafeAreaInsets();
  const [perm, requestPerm] = useCameraPermissions();
  const ref = useRef<CameraView>(null);
  const [busy, setBusy] = useState(false);
  const shoot = async () => {
    if (!ref.current || busy) return;
    setBusy(true);
    try {
      const pic = await ref.current.takePictureAsync({ base64: true, quality: 0.5, skipProcessing: false });
      if (!pic?.base64) throw new Error("the camera returned no picture");
      props.onShot(`data:image/jpeg;base64,${pic.base64}`);
    } catch (e) {
      props.onError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal visible={props.visible} animationType="slide" onRequestClose={props.onClose}>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        {perm?.granted ? (
          <CameraView ref={ref} style={{ flex: 1 }} facing="back" />
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 }}>
            <Text style={{ color: "#fff", fontSize: 15, textAlign: "center" }}>Loom needs the camera to take the photo.</Text>
            <TouchableOpacity onPress={() => void requestPerm()} style={{ paddingHorizontal: 18, height: 42, borderRadius: radii.key, backgroundColor: "#fff", justifyContent: "center" }}>
              <Text style={{ color: "#000", fontWeight: "700" }}>Allow camera</Text>
            </TouchableOpacity>
          </View>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 24, paddingBottom: 24 + Math.max(20, insets.bottom) }}>
          <TouchableOpacity onPress={props.onClose} accessibilityRole="button" style={{ minWidth: 70 }}>
            <Text style={{ color: "#fff", fontSize: 16 }}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => void shoot()} disabled={!perm?.granted || busy} accessibilityRole="button" accessibilityLabel="Take the photo"
            style={{ width: 70, height: 70, borderRadius: 35, borderWidth: 4, borderColor: "#fff", alignItems: "center", justifyContent: "center", opacity: perm?.granted ? 1 : 0.4 }}>
            {busy ? <ActivityIndicator color="#fff" /> : <View style={{ width: 54, height: 54, borderRadius: 27, backgroundColor: "#fff" }} />}
          </TouchableOpacity>
          <View style={{ minWidth: 70 }} />
        </View>
      </View>
    </Modal>
  );
}

/** What's attached to the message being written, above the box. */
export function AttachBar(props: { items: Attached[]; onRemove: (id: number) => void }) {
  if (!props.items.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 10, paddingTop: 8 }}>
      {props.items.map((a) => (
        <View key={a.id} style={{ width: 56, height: 56, borderRadius: 10, overflow: "hidden", borderWidth: 1, borderColor: T.line, backgroundColor: T.raised }}>
          <Image source={{ uri: a.uri }} style={{ width: "100%", height: "100%", opacity: a.uploading ? 0.4 : 1 }} />
          {a.uploading ? <ActivityIndicator color={T.text} style={{ position: "absolute", top: 18, left: 18 }} /> : null}
          <TouchableOpacity onPress={() => props.onRemove(a.id)} accessibilityLabel={`remove ${a.name}`} hitSlop={{ top: 6, right: 6, bottom: 6, left: 6 }}
            style={{ position: "absolute", top: 2, right: 2, width: 18, height: 18, borderRadius: 9, backgroundColor: "rgba(0,0,0,0.65)", alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: "#fff", fontSize: 11, lineHeight: 13 }}>×</Text>
          </TouchableOpacity>
        </View>
      ))}
    </ScrollView>
  );
}
