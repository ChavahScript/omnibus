import React, { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { VectorIcon } from "./VectorIcon";
import { colors } from "../theme";

export function QRScanner({ visible, onCode, onClose }: { visible: boolean; onCode: (value: string) => void; onClose: () => void }): React.JSX.Element | null {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  useEffect(() => {
    if (visible) setScanned(false);
  }, [visible]);
  if (!visible) return null;
  if (!permission?.granted) return <Modal visible transparent animationType="slide"><View style={styles.permission}><Text style={styles.permissionText}>Camera access is used only to scan the one-time pairing code from your laptop.</Text><Pressable style={styles.permissionButton} onPress={() => void requestPermission()}><Text style={styles.actionText}>ALLOW CAMERA</Text></Pressable><Pressable onPress={onClose}><Text style={styles.cancel}>Cancel</Text></Pressable></View></Modal>;
  return <Modal visible animationType="slide"><View style={styles.screen}>
    <CameraView style={StyleSheet.absoluteFill} barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={scanned ? undefined : event => { setScanned(true); onCode(event.data); }} />
    <View style={styles.top}><Text style={styles.title}>PAIR YOUR LAPTOP</Text><Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close scanner"><Text style={styles.cancel}>Close</Text></Pressable></View>
    <View style={styles.frame}><View style={[styles.corner, styles.topLeft]} /><View style={[styles.corner, styles.topRight]} /><View style={[styles.corner, styles.bottomLeft]} /><View style={[styles.corner, styles.bottomRight]} /></View>
    <View style={styles.instructions}><VectorIcon name="scan" color={colors.paper} /><Text style={styles.instructionText}>Scan the one-time code printed by the Omnibus bridge. After it verifies, this iPhone can securely reconnect while the bridge stays available.</Text></View>
  </View></Modal>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 24, paddingTop: 70 },
  title: { color: colors.paper, fontSize: 11, fontWeight: "900", letterSpacing: 1.5 },
  cancel: { color: colors.paper, fontSize: 15, marginTop: 18 },
  frame: { position: "absolute", width: 252, height: 252, left: "50%", top: "50%", marginLeft: -126, marginTop: -126 },
  corner: { position: "absolute", width: 38, height: 38, borderColor: colors.paper },
  topLeft: { left: 0, top: 0, borderLeftWidth: 4, borderTopWidth: 4 }, topRight: { right: 0, top: 0, borderRightWidth: 4, borderTopWidth: 4 }, bottomLeft: { left: 0, bottom: 0, borderLeftWidth: 4, borderBottomWidth: 4 }, bottomRight: { right: 0, bottom: 0, borderRightWidth: 4, borderBottomWidth: 4 },
  instructions: { position: "absolute", bottom: 84, left: 28, right: 28, flexDirection: "row", gap: 14, alignItems: "center", padding: 18, borderRadius: 16, backgroundColor: "rgba(12,12,13,.9)", borderWidth: 1, borderColor: colors.line },
  instructionText: { color: colors.paper, flex: 1, fontSize: 14, lineHeight: 20 },
  permission: { flex: 1, padding: 32, alignItems: "center", justifyContent: "center", backgroundColor: colors.ink },
  permissionText: { color: colors.paper, fontSize: 18, lineHeight: 26, textAlign: "center" },
  permissionButton: { paddingHorizontal: 24, paddingVertical: 14, borderRadius: 12, marginTop: 24, backgroundColor: colors.paper },
  actionText: { color: colors.ink, fontSize: 15, fontWeight: "800" },
});
