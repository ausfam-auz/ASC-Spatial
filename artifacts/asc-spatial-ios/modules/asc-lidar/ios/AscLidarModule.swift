import ARKit
import AVFoundation
import ExpoModulesCore
import Foundation
import simd

private struct PlyTriangle {
  let a: UInt32
  let b: UInt32
  let c: UInt32
}

private struct PlyMesh {
  let vertices: [SIMD3<Float>]
  let triangles: [PlyTriangle]
  let decimationFactor: Int
}

private final class AscLidarSessionDelegate: NSObject, ARSessionDelegate {
  var onAnchorsChanged: (([ARAnchor], [UUID]) -> Void)?

  func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
    onAnchorsChanged?(anchors, [])
  }

  func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
    onAnchorsChanged?(anchors, [])
  }

  func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
    onAnchorsChanged?([], anchors.map(\.identifier))
  }
}

public final class AscLidarModule: Module {
  private let session = ARSession()
  private let sessionDelegate = AscLidarSessionDelegate()
  private let delegateQueue = DispatchQueue(label: "com.ascspatial.lidar.session")
  private let stateLock = NSLock()
  private let maximumTriangleCount = 1_000_000
  private let maximumPointCount = 1_500_000
  private let maximumFileSize = 100 * 1024 * 1024

  private var meshAnchors: [UUID: ARMeshAnchor] = [:]
  private var isCapturing = false
  private var captureStartedAt: Date?
  private var lastProgressEventTime: TimeInterval = 0

  public func definition() -> ModuleDefinition {
    Name("AscLidar")
    Events("onCaptureProgress", "onCompressionProgress")

    Function("getDeviceStatus") { () -> [String: Any] in
      self.deviceStatus()
    }

    AsyncFunction("requestCameraPermission") { (promise: Promise) in
      let currentStatus = AVCaptureDevice.authorizationStatus(for: .video)
      guard currentStatus == .notDetermined else {
        promise.resolve(self.deviceStatus())
        return
      }

      AVCaptureDevice.requestAccess(for: .video) { [weak self] _ in
        guard let self else {
          promise.resolve([
            "supported": false,
            "cameraPermission": "unavailable",
            "canAskAgain": false,
            "reason": "Camera permission status is unavailable.",
          ])
          return
        }
        promise.resolve(self.deviceStatus())
      }
    }

    AsyncFunction("startCapture") { () throws -> [String: Bool] in
      let status = self.deviceStatus()
      guard status["supported"] as? Bool == true else {
        throw self.scanError(
          status["reason"] as? String ?? "LiDAR capture is not supported on this device."
        )
      }
      guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
        throw self.scanError("Allow camera access before starting a LiDAR scan.")
      }

      self.stateLock.lock()
      guard !self.isCapturing else {
        self.stateLock.unlock()
        throw self.scanError("A LiDAR scan is already in progress.")
      }
      self.meshAnchors.removeAll(keepingCapacity: true)
      self.isCapturing = true
      self.captureStartedAt = Date()
      self.lastProgressEventTime = 0
      self.stateLock.unlock()

      let configuration = ARWorldTrackingConfiguration()
      configuration.sceneReconstruction = .mesh
      configuration.environmentTexturing = .automatic
      self.session.run(
        configuration,
        options: [.resetTracking, .removeExistingAnchors]
      )
      return ["started": true]
    }

    AsyncFunction("finishCapture") { () throws -> [String: Any] in
      try self.finishCapture()
    }

    Function("cancelCapture") {
      self.cancelCapture()
    }

    Function("removeCapturedFile") { (uri: String) in
      self.removeCapturedFile(uri)
    }
  }

  public override func didCreate() {
    sessionDelegate.onAnchorsChanged = { [weak self] incoming, removed in
      self?.updateMeshAnchors(incoming, removed: removed)
    }
    session.delegate = sessionDelegate
    session.delegateQueue = delegateQueue
  }

  public override func willDestroy() {
    cancelCapture()
    session.delegate = nil
    sessionDelegate.onAnchorsChanged = nil
  }

  private func deviceStatus() -> [String: Any] {
    let cameraStatus = AVCaptureDevice.authorizationStatus(for: .video)
    let cameraPermission: String
    let canAskAgain: Bool

    switch cameraStatus {
    case .authorized:
      cameraPermission = "authorized"
      canAskAgain = false
    case .notDetermined:
      cameraPermission = "notDetermined"
      canAskAgain = true
    case .denied:
      cameraPermission = "denied"
      canAskAgain = false
    case .restricted:
      cameraPermission = "restricted"
      canAskAgain = false
    @unknown default:
      cameraPermission = "unavailable"
      canAskAgain = false
    }

    let supported =
      ARWorldTrackingConfiguration.isSupported &&
      ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    let reason: String
    if !ARWorldTrackingConfiguration.isSupported {
      reason = "AR scanning is not supported on this device."
    } else if !supported {
      reason = "LiDAR capture requires a LiDAR-equipped iPhone Pro or iPad Pro."
    } else if cameraStatus != .authorized {
      reason = "Camera access is required to capture a LiDAR scan."
    } else {
      reason = "LiDAR capture is ready."
    }

    return [
      "supported": supported,
      "cameraPermission": cameraPermission,
      "canAskAgain": canAskAgain,
      "reason": reason,
    ]
  }

  private func updateMeshAnchors(_ incoming: [ARAnchor], removed: [UUID]) {
    var event: [String: Any]?
    let now = Date()

    stateLock.lock()
    guard isCapturing else {
      stateLock.unlock()
      return
    }

    for anchor in incoming {
      if let mesh = anchor as? ARMeshAnchor {
        meshAnchors[mesh.identifier] = mesh
      }
    }
    for identifier in removed {
      meshAnchors.removeValue(forKey: identifier)
    }

    let currentTime = now.timeIntervalSince1970
    if currentTime - lastProgressEventTime >= 0.35 {
      lastProgressEventTime = currentTime
      let elapsed = now.timeIntervalSince(captureStartedAt ?? now)
      let progress = min(0.92, 0.02 + Double(meshAnchors.count) / 120.0)
      event = [
        "progress": progress,
        "meshCount": meshAnchors.count,
        "elapsedSeconds": elapsed,
      ]
    }
    stateLock.unlock()

    guard let event else { return }
    DispatchQueue.main.async {
      self.sendEvent("onCaptureProgress", event)
    }
  }

  private func finishCapture() throws -> [String: Any] {
    stateLock.lock()
    guard isCapturing else {
      stateLock.unlock()
      throw scanError("Start a LiDAR scan before finishing it.")
    }
    isCapturing = false
    let anchors = Array(meshAnchors.values)
    meshAnchors.removeAll(keepingCapacity: false)
    captureStartedAt = nil
    stateLock.unlock()

    session.pause()
    guard !anchors.isEmpty else {
      throw scanError("No scan mesh was captured. Move around the surface and try again.")
    }

    sendCompressionProgress(0.08, stage: "Preparing captured mesh")
    let mesh = try buildMesh(from: anchors)
    guard mesh.vertices.count >= 3 else {
      throw scanError("The scan did not contain enough 3D points. Capture a larger area.")
    }

    sendCompressionProgress(0.55, stage: "Writing compact PLY file")
    let outputURL = try createOutputURL()
    do {
      try writePLY(mesh, to: outputURL)
      let attributes = try FileManager.default.attributesOfItem(atPath: outputURL.path)
      let fileSize = (attributes[.size] as? NSNumber)?.intValue ?? 0
      guard fileSize > 0, fileSize <= maximumFileSize else {
        try? FileManager.default.removeItem(at: outputURL)
        throw scanError("The captured scan exceeds the 100 MiB upload limit.")
      }

      sendCompressionProgress(1, stage: "Scan ready")
      return [
        "uri": outputURL.absoluteString,
        "name": outputURL.lastPathComponent,
        "size": fileSize,
        "vertexCount": mesh.vertices.count,
        "faceCount": mesh.triangles.count,
        "decimationFactor": mesh.decimationFactor,
      ]
    } catch {
      try? FileManager.default.removeItem(at: outputURL)
      throw error
    }
  }

  private func buildMesh(from anchors: [ARMeshAnchor]) throws -> PlyMesh {
    let sortedAnchors = anchors.sorted {
      $0.identifier.uuidString < $1.identifier.uuidString
    }
    let totalFaceCount = sortedAnchors.reduce(0) {
      $0 + $1.geometry.faces.count
    }

    if totalFaceCount == 0 {
      return buildPointCloud(from: sortedAnchors)
    }

    let decimationFactor = max(
      1,
      Int(ceil(Double(totalFaceCount) / Double(maximumTriangleCount)))
    )
    var vertices: [SIMD3<Float>] = []
    var triangles: [PlyTriangle] = []

    for (anchorIndex, anchor) in sortedAnchors.enumerated() {
      let geometry = anchor.geometry
      let vertexSource = geometry.vertices
      let faceSource = geometry.faces
      guard faceSource.indexCountPerPrimitive == 3 else { continue }

      let vertexBuffer = vertexSource.buffer.contents()
      let faceBuffer = faceSource.buffer.contents()
      var localToGlobal: [UInt32: UInt32] = [:]

      func globalIndex(for localIndex: UInt32) -> UInt32? {
        if let existing = localToGlobal[localIndex] {
          return existing
        }
        let vertexIndex = Int(localIndex)
        guard vertexIndex >= 0, vertexIndex < vertexSource.count else {
          return nil
        }

        let byteOffset = vertexSource.offset + vertexIndex * vertexSource.stride
        let vertexPointer = vertexBuffer.advanced(by: byteOffset)
        let x = vertexPointer.loadUnaligned(as: Float.self)
        let y = vertexPointer.advanced(by: MemoryLayout<Float>.size)
          .loadUnaligned(as: Float.self)
        let z = vertexPointer.advanced(by: MemoryLayout<Float>.size * 2)
          .loadUnaligned(as: Float.self)
        let world = simd_mul(
          anchor.transform,
          SIMD4<Float>(x, y, z, 1)
        )
        let point = SIMD3<Float>(world.x, world.y, world.z)
        guard point.x.isFinite, point.y.isFinite, point.z.isFinite else {
          return nil
        }

        let globalIndex = UInt32(vertices.count)
        vertices.append(point)
        localToGlobal[localIndex] = globalIndex
        return globalIndex
      }

      for faceIndex in stride(
        from: 0,
        to: faceSource.count,
        by: decimationFactor
      ) {
        let faceOffset =
          faceIndex * faceSource.indexCountPerPrimitive * faceSource.bytesPerIndex
        guard
          let a = readIndex(faceBuffer, offset: faceOffset, byteWidth: faceSource.bytesPerIndex),
          let b = readIndex(faceBuffer, offset: faceOffset + faceSource.bytesPerIndex, byteWidth: faceSource.bytesPerIndex),
          let c = readIndex(faceBuffer, offset: faceOffset + faceSource.bytesPerIndex * 2, byteWidth: faceSource.bytesPerIndex),
          let globalA = globalIndex(for: a),
          let globalB = globalIndex(for: b),
          let globalC = globalIndex(for: c)
        else {
          continue
        }
        triangles.append(PlyTriangle(a: globalA, b: globalB, c: globalC))
      }

      if anchorIndex.isMultiple(of: 20) {
        let ratio = Double(anchorIndex + 1) / Double(max(sortedAnchors.count, 1))
        sendCompressionProgress(
          0.15 + ratio * 0.3,
          stage: "Reducing mesh density"
        )
      }
    }

    guard !triangles.isEmpty else {
      return buildPointCloud(from: sortedAnchors)
    }
    return PlyMesh(
      vertices: vertices,
      triangles: triangles,
      decimationFactor: decimationFactor
    )
  }

  private func buildPointCloud(from anchors: [ARMeshAnchor]) -> PlyMesh {
    let totalVertices = anchors.reduce(0) {
      $0 + $1.geometry.vertices.count
    }
    let decimationFactor = max(
      1,
      Int(ceil(Double(totalVertices) / Double(maximumPointCount)))
    )
    var vertices: [SIMD3<Float>] = []

    for anchor in anchors {
      let source = anchor.geometry.vertices
      let buffer = source.buffer.contents()
      for vertexIndex in stride(from: 0, to: source.count, by: decimationFactor) {
        let pointer = buffer.advanced(by: source.offset + vertexIndex * source.stride)
        let x = pointer.loadUnaligned(as: Float.self)
        let y = pointer.advanced(by: MemoryLayout<Float>.size)
          .loadUnaligned(as: Float.self)
        let z = pointer.advanced(by: MemoryLayout<Float>.size * 2)
          .loadUnaligned(as: Float.self)
        let world = simd_mul(
          anchor.transform,
          SIMD4<Float>(x, y, z, 1)
        )
        let point = SIMD3<Float>(world.x, world.y, world.z)
        if point.x.isFinite, point.y.isFinite, point.z.isFinite {
          vertices.append(point)
        }
      }
    }

    return PlyMesh(
      vertices: vertices,
      triangles: [],
      decimationFactor: decimationFactor
    )
  }

  private func writePLY(_ mesh: PlyMesh, to url: URL) throws {
    let header = [
      "ply",
      "format binary_little_endian 1.0",
      "comment ASC Spatial ARKit LiDAR capture",
      "element vertex \(mesh.vertices.count)",
      "property float x",
      "property float y",
      "property float z",
      "element face \(mesh.triangles.count)",
      "property list uchar uint vertex_indices",
      "end_header",
    ].joined(separator: "\n") + "\n"
    guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
      throw scanError("The scan file could not be created.")
    }

    let file = try FileHandle(forWritingTo: url)
    defer { try? file.close() }
    try file.write(contentsOf: Data(header.utf8))

    var chunk = Data()
    chunk.reserveCapacity(256 * 1024)
    for (index, vertex) in mesh.vertices.enumerated() {
      chunk.appendLittleEndian(vertex.x)
      chunk.appendLittleEndian(vertex.y)
      chunk.appendLittleEndian(vertex.z)
      if chunk.count >= 256 * 1024 {
        try file.write(contentsOf: chunk)
        chunk.removeAll(keepingCapacity: true)
      }
      if index.isMultiple(of: 250_000), index > 0 {
        let ratio = Double(index) / Double(max(mesh.vertices.count, 1))
        sendCompressionProgress(0.55 + ratio * 0.25, stage: "Writing scan points")
      }
    }

    for (index, triangle) in mesh.triangles.enumerated() {
      chunk.append(3)
      chunk.appendLittleEndian(triangle.a)
      chunk.appendLittleEndian(triangle.b)
      chunk.appendLittleEndian(triangle.c)
      if chunk.count >= 256 * 1024 {
        try file.write(contentsOf: chunk)
        chunk.removeAll(keepingCapacity: true)
      }
      if index.isMultiple(of: 250_000), index > 0 {
        let ratio = Double(index) / Double(max(mesh.triangles.count, 1))
        sendCompressionProgress(0.8 + ratio * 0.15, stage: "Writing scan surfaces")
      }
    }

    if !chunk.isEmpty {
      try file.write(contentsOf: chunk)
    }
  }

  private func createOutputURL() throws -> URL {
    guard let cacheDirectory = FileManager.default.urls(
      for: .cachesDirectory,
      in: .userDomainMask
    ).first else {
      throw scanError("The device scan folder is unavailable.")
    }
    let scanDirectory = cacheDirectory
      .appendingPathComponent("asc-spatial", isDirectory: true)
      .appendingPathComponent("scans", isDirectory: true)
    try FileManager.default.createDirectory(
      at: scanDirectory,
      withIntermediateDirectories: true
    )
    let filename = "ASC-Scan-\(UUID().uuidString).ply"
    return scanDirectory.appendingPathComponent(filename, isDirectory: false)
  }

  private func removeCapturedFile(_ uri: String) {
    guard let url = URL(string: uri), url.isFileURL else { return }
    let standardizedTarget = url.standardizedFileURL
    guard let cacheDirectory = FileManager.default.urls(
      for: .cachesDirectory,
      in: .userDomainMask
    ).first else {
      return
    }
    let allowedDirectory = cacheDirectory
      .appendingPathComponent("asc-spatial", isDirectory: true)
      .appendingPathComponent("scans", isDirectory: true)
      .standardizedFileURL
      .path + "/"
    guard standardizedTarget.path.hasPrefix(allowedDirectory) else { return }
    try? FileManager.default.removeItem(at: standardizedTarget)
  }

  private func cancelCapture() {
    stateLock.lock()
    isCapturing = false
    meshAnchors.removeAll(keepingCapacity: false)
    captureStartedAt = nil
    stateLock.unlock()
    session.pause()
  }

  private func sendCompressionProgress(_ progress: Double, stage: String) {
    DispatchQueue.main.async {
      self.sendEvent("onCompressionProgress", [
        "progress": progress,
        "stage": stage,
      ])
    }
  }

  private func scanError(_ message: String) -> NSError {
    NSError(
      domain: "AscLidar",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: message]
    )
  }

  private func readIndex(
    _ base: UnsafeMutableRawPointer,
    offset: Int,
    byteWidth: Int
  ) -> UInt32? {
    let pointer = UnsafeRawPointer(base.advanced(by: offset))
    switch byteWidth {
    case MemoryLayout<UInt16>.size:
      return UInt32(pointer.loadUnaligned(as: UInt16.self))
    case MemoryLayout<UInt32>.size:
      return pointer.loadUnaligned(as: UInt32.self)
    default:
      return nil
    }
  }
}

private extension Data {
  mutating func appendLittleEndian(_ value: Float) {
    var bits = value.bitPattern.littleEndian
    Swift.withUnsafeBytes(of: &bits) { append(contentsOf: $0) }
  }

  mutating func appendLittleEndian(_ value: UInt32) {
    var littleEndianValue = value.littleEndian
    Swift.withUnsafeBytes(of: &littleEndianValue) {
      append(contentsOf: $0)
    }
  }
}
