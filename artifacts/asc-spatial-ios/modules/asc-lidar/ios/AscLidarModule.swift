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

private struct VoxelKey: Hashable {
  let x: Int
  let y: Int
  let z: Int
}

private struct MeshEdge: Hashable {
  let low: UInt32
  let high: UInt32

  init(_ first: UInt32, _ second: UInt32) {
    low = min(first, second)
    high = max(first, second)
  }
}

public final class AscLidarModule: Module {
  private let session = ARSession()
  private let stateLock = NSLock()
  private let defaultTriangleCount = 250_000
  private let maximumTriangleCount = 1_000_000
  private let maximumPointCount = 1_500_000
  private let maximumFileSize = 100 * 1024 * 1024

  private var meshAnchors: [UUID: ARMeshAnchor] = [:]
  private var isCapturing = false
  private var isCapturePaused = false
  private var captureConfiguration: ARWorldTrackingConfiguration?
  private var captureOrigin = SIMD3<Float>(repeating: 0)
  private var captureStartedAt: Date?
  private var lastProgressEventTime: TimeInterval = 0

  public func definition() -> ModuleDefinition {
    Name("AscLidar")
    Events("onCaptureProgress", "onCompressionProgress")

    View(AscLidarPreviewView.self) {
      ViewName("Preview")
      OnViewDidUpdateProps { [weak self] view in
        guard let self else { return }
        view.connect(session: self.session) { [weak self] incoming, removed in
          self?.updateMeshAnchors(incoming, removed: removed)
        }
      }
    }

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
      self.isCapturePaused = false
      self.captureOrigin = SIMD3<Float>(repeating: 0)
      self.captureStartedAt = Date()
      self.lastProgressEventTime = 0

      let configuration = ARWorldTrackingConfiguration()
      configuration.sceneReconstruction = .mesh
      configuration.environmentTexturing = .automatic
      self.captureConfiguration = configuration
      self.stateLock.unlock()
      self.session.run(
        configuration,
        options: [.resetTracking, .removeExistingAnchors]
      )
      return ["started": true]
    }

    Function("pauseCapture") {
      self.pauseCapture()
    }

    Function("resumeCapture") { () throws -> [String: Bool] in
      try self.resumeCapture()
      return ["resumed": true]
    }

    AsyncFunction("finishCapture") {
      (processingMode: String, options: [String: Any]) throws -> [String: Any] in
      try self.finishCapture(
        processingMode: processingMode,
        options: options
      )
    }

    Function("cancelCapture") {
      self.cancelCapture()
    }

    Function("removeCapturedFile") { (uri: String) in
      self.removeCapturedFile(uri)
    }
  }

  public override func willDestroy() {
    cancelCapture()
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
      let vertexCount = meshAnchors.values.reduce(0) {
        $0 + $1.geometry.vertices.count
      }
      let faceCount = meshAnchors.values.reduce(0) {
        $0 + $1.geometry.faces.count
      }
      event = [
        "meshCount": meshAnchors.count,
        "vertexCount": vertexCount,
        "faceCount": faceCount,
        "elapsedSeconds": elapsed,
      ]
    }
    stateLock.unlock()

    guard let event else { return }
    DispatchQueue.main.async {
      self.sendEvent("onCaptureProgress", event)
    }
  }

  private func pauseCapture() {
    stateLock.lock()
    guard isCapturing, !isCapturePaused else {
      stateLock.unlock()
      return
    }
    isCapturePaused = true
    stateLock.unlock()
    session.pause()
  }

  private func resumeCapture() throws {
    stateLock.lock()
    guard isCapturing, isCapturePaused, let configuration = captureConfiguration else {
      stateLock.unlock()
      throw scanError("There is no paused LiDAR scan to resume.")
    }
    isCapturePaused = false
    stateLock.unlock()
    session.run(configuration)
  }

  private func finishCapture(
    processingMode: String,
    options: [String: Any]
  ) throws -> [String: Any] {
    guard ["default", "dense", "custom", "cloud"].contains(processingMode) else {
      throw scanError("Choose a supported scan processing option.")
    }
    stateLock.lock()
    guard isCapturing else {
      stateLock.unlock()
      throw scanError("Start a LiDAR scan before finishing it.")
    }
    isCapturing = false
    isCapturePaused = false
    captureConfiguration = nil
    let origin = captureOrigin
    let anchors = Array(meshAnchors.values)
    meshAnchors.removeAll(keepingCapacity: false)
    captureStartedAt = nil
    stateLock.unlock()

    session.pause()
    guard !anchors.isEmpty else {
      throw scanError("No scan mesh was captured. Move around the surface and try again.")
    }

    sendCompressionProgress(0.08, stage: "Preparing captured mesh")
    let depthRangeMeters = Float(
      min(10, max(1, options["depthRangeMeters"] as? Double ?? 5.2))
    )
    let voxelSizeMeters = Float(
      min(0.03, max(0.002, options["voxelSizeMillimeters"] as? Double ?? 10)) /
        1_000
    )
    let simplificationPercent = min(
      90,
      max(0, options["simplificationPercent"] as? Double ?? 45)
    )
    let automaticCrop = options["automaticCrop"] as? Bool ?? false
    let fillHoles = options["fillHoles"] as? Bool ?? false
    var processingWarnings: [String] = []
    let mesh: PlyMesh
    if processingMode == "cloud" {
      sendCompressionProgress(0.15, stage: "Preparing point cloud")
      mesh = buildPointCloud(
        from: anchors,
        depthRangeMeters: depthRangeMeters,
        captureOrigin: origin,
        voxelSizeMeters: voxelSizeMeters
      )
    } else {
      let maximumTriangles: Int
      switch processingMode {
      case "dense":
        maximumTriangles = maximumTriangleCount
      case "custom":
        maximumTriangles = max(
          100_000,
          Int(
            Double(maximumTriangleCount) *
              (1 - simplificationPercent / 100)
          )
        )
      default:
        maximumTriangles = defaultTriangleCount
      }
      var processedMesh = try buildMesh(
        from: anchors,
        maximumTriangles: maximumTriangles,
        depthRangeMeters: depthRangeMeters,
        captureOrigin: origin,
        voxelSizeMeters: voxelSizeMeters
      )
      if automaticCrop {
        processedMesh = cropOutlierGeometry(processedMesh)
      }
      if fillHoles {
        if processedMesh.triangles.count > 200_000 {
          processingWarnings.append(
            "Small-hole filling was skipped because this scan exceeded the on-device processing limit."
          )
        } else {
          processedMesh = fillSmallHoles(in: processedMesh)
        }
      }
      mesh = processedMesh
    }
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
        "processingMode": processingMode,
        "processingWarnings": processingWarnings,
      ]
    } catch {
      try? FileManager.default.removeItem(at: outputURL)
      throw error
    }
  }

  private func buildMesh(
    from anchors: [ARMeshAnchor],
    maximumTriangles: Int,
    depthRangeMeters: Float,
    captureOrigin: SIMD3<Float>,
    voxelSizeMeters: Float
  ) throws -> PlyMesh {
    let sortedAnchors = anchors.sorted {
      $0.identifier.uuidString < $1.identifier.uuidString
    }
    let totalFaceCount = sortedAnchors.reduce(0) {
      $0 + $1.geometry.faces.count
    }

    if totalFaceCount == 0 {
      return buildPointCloud(
        from: sortedAnchors,
        depthRangeMeters: depthRangeMeters,
        captureOrigin: captureOrigin,
        voxelSizeMeters: voxelSizeMeters
      )
    }

    let decimationFactor = max(
      1,
      Int(ceil(Double(totalFaceCount) / Double(maximumTriangles)))
    )
    var vertices: [SIMD3<Float>] = []
    var triangles: [PlyTriangle] = []
    var voxelToGlobal: [VoxelKey: UInt32] = [:]

    for (anchorIndex, anchor) in sortedAnchors.enumerated() {
      let geometry = anchor.geometry
      let vertexSource = geometry.vertices
      let faceSource = geometry.faces
      guard faceSource.indexCountPerPrimitive == 3 else { continue }

      let vertexBuffer = vertexSource.buffer.contents()
      let faceBuffer = faceSource.buffer.contents()
      var localToGlobal: [UInt32: UInt32] = [:]
      var rejectedLocalIndices = Set<UInt32>()

      func globalIndex(for localIndex: UInt32) -> UInt32? {
        if let existing = localToGlobal[localIndex] {
          return existing
        }
        if rejectedLocalIndices.contains(localIndex) {
          return nil
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
          rejectedLocalIndices.insert(localIndex)
          return nil
        }
        guard simd_distance(point, captureOrigin) <= depthRangeMeters else {
          rejectedLocalIndices.insert(localIndex)
          return nil
        }

        let voxel = VoxelKey(
          x: Int(floor(point.x / voxelSizeMeters)),
          y: Int(floor(point.y / voxelSizeMeters)),
          z: Int(floor(point.z / voxelSizeMeters))
        )
        if let existing = voxelToGlobal[voxel] {
          localToGlobal[localIndex] = existing
          return existing
        }
        guard vertices.count < maximumPointCount else {
          rejectedLocalIndices.insert(localIndex)
          return nil
        }
        let globalIndex = UInt32(vertices.count)
        vertices.append(point)
        voxelToGlobal[voxel] = globalIndex
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
        guard globalA != globalB, globalB != globalC, globalC != globalA else {
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
      return buildPointCloud(
        from: sortedAnchors,
        depthRangeMeters: depthRangeMeters,
        captureOrigin: captureOrigin,
        voxelSizeMeters: voxelSizeMeters
      )
    }
    return PlyMesh(
      vertices: vertices,
      triangles: triangles,
      decimationFactor: decimationFactor
    )
  }

  private func buildPointCloud(
    from anchors: [ARMeshAnchor],
    depthRangeMeters: Float,
    captureOrigin: SIMD3<Float>,
    voxelSizeMeters: Float
  ) -> PlyMesh {
    let totalVertices = anchors.reduce(0) {
      $0 + $1.geometry.vertices.count
    }
    let decimationFactor = max(
      1,
      Int(ceil(Double(totalVertices) / Double(maximumPointCount)))
    )
    var vertices: [SIMD3<Float>] = []
    var seenVoxels = Set<VoxelKey>()

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
        guard
          point.x.isFinite,
          point.y.isFinite,
          point.z.isFinite,
          simd_distance(point, captureOrigin) <= depthRangeMeters
        else {
          continue
        }
        let voxel = VoxelKey(
          x: Int(floor(point.x / voxelSizeMeters)),
          y: Int(floor(point.y / voxelSizeMeters)),
          z: Int(floor(point.z / voxelSizeMeters))
        )
        if seenVoxels.insert(voxel).inserted {
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

  private func cropOutlierGeometry(_ mesh: PlyMesh) -> PlyMesh {
    guard mesh.vertices.count >= 20 else { return mesh }
    let sampleStep = max(1, mesh.vertices.count / 8_192)
    let sample = stride(from: 0, to: mesh.vertices.count, by: sampleStep)
      .map { mesh.vertices[$0] }

    func percentile(_ values: [Float], _ fraction: Float) -> Float {
      let sorted = values.sorted()
      let index = Int(
        (Float(sorted.count - 1) * fraction).rounded(.down)
      )
      return sorted[index]
    }

    let lowerX = percentile(sample.map(\.x), 0.005)
    let lowerY = percentile(sample.map(\.y), 0.005)
    let lowerZ = percentile(sample.map(\.z), 0.005)
    let upperX = percentile(sample.map(\.x), 0.995)
    let upperY = percentile(sample.map(\.y), 0.995)
    let upperZ = percentile(sample.map(\.z), 0.995)
    func isInside(_ point: SIMD3<Float>) -> Bool {
      point.x >= lowerX && point.x <= upperX &&
        point.y >= lowerY && point.y <= upperY &&
        point.z >= lowerZ && point.z <= upperZ
    }

    guard !mesh.triangles.isEmpty else {
      let croppedPoints = mesh.vertices.filter(isInside)
      return croppedPoints.count >= 3
        ? PlyMesh(
            vertices: croppedPoints,
            triangles: [],
            decimationFactor: mesh.decimationFactor
          )
        : mesh
    }

    let croppedTriangles = mesh.triangles.filter { triangle in
      guard
        Int(triangle.a) < mesh.vertices.count,
        Int(triangle.b) < mesh.vertices.count,
        Int(triangle.c) < mesh.vertices.count
      else {
        return false
      }
      let a = mesh.vertices[Int(triangle.a)]
      let b = mesh.vertices[Int(triangle.b)]
      let c = mesh.vertices[Int(triangle.c)]
      return isInside(a) && isInside(b) && isInside(c)
    }
    guard !croppedTriangles.isEmpty else { return mesh }
    return compactMesh(
      vertices: mesh.vertices,
      triangles: croppedTriangles,
      decimationFactor: mesh.decimationFactor
    )
  }

  private func fillSmallHoles(in mesh: PlyMesh) -> PlyMesh {
    guard
      !mesh.triangles.isEmpty,
      mesh.triangles.count <= 200_000
    else {
      return mesh
    }
    var edgeUseCount: [MeshEdge: Int] = [:]
    var neighbors: [UInt32: Set<UInt32>] = [:]

    func registerEdge(_ first: UInt32, _ second: UInt32) {
      let edge = MeshEdge(first, second)
      edgeUseCount[edge, default: 0] += 1
      neighbors[first, default: []].insert(second)
      neighbors[second, default: []].insert(first)
    }

    for triangle in mesh.triangles {
      registerEdge(triangle.a, triangle.b)
      registerEdge(triangle.b, triangle.c)
      registerEdge(triangle.c, triangle.a)
    }

    var remainingEdges = Set(
      edgeUseCount.compactMap { $0.value == 1 ? $0.key : nil }
    )
    guard !remainingEdges.isEmpty else { return mesh }
    var vertices = mesh.vertices
    var triangles = mesh.triangles
    let candidateEdges = Array(remainingEdges)

    for edge in candidateEdges {
      guard remainingEdges.contains(edge) else { continue }
      var loop: [UInt32] = [edge.low, edge.high]
      remainingEdges.remove(edge)
      var current = edge.high
      var closed = false

      while loop.count <= 32 {
        let next = (neighbors[current] ?? []).first { candidate in
          remainingEdges.contains(MeshEdge(current, candidate))
        }
        guard let next else { break }
        remainingEdges.remove(MeshEdge(current, next))
        if next == loop[0] {
          closed = true
          break
        }
        loop.append(next)
        current = next
      }

      guard closed, loop.count >= 3, loop.count <= 32 else { continue }
      let validLoop = loop.filter { Int($0) < vertices.count }
      guard validLoop.count == loop.count else { continue }
      let center = validLoop.reduce(SIMD3<Float>(repeating: 0)) {
        $0 + vertices[Int($1)]
      } / Float(validLoop.count)
      let radius = validLoop.map {
        simd_distance(vertices[Int($0)], center)
      }.max() ?? .infinity
      guard radius <= 0.18, vertices.count < maximumPointCount else {
        continue
      }

      let centerIndex = UInt32(vertices.count)
      vertices.append(center)
      for index in validLoop.indices {
        let nextIndex = (index + 1) % validLoop.count
        triangles.append(
          PlyTriangle(
            a: validLoop[index],
            b: validLoop[nextIndex],
            c: centerIndex
          )
        )
      }
    }

    guard triangles.count > mesh.triangles.count else { return mesh }
    return PlyMesh(
      vertices: vertices,
      triangles: triangles,
      decimationFactor: mesh.decimationFactor
    )
  }

  private func compactMesh(
    vertices sourceVertices: [SIMD3<Float>],
    triangles sourceTriangles: [PlyTriangle],
    decimationFactor: Int
  ) -> PlyMesh {
    var vertices: [SIMD3<Float>] = []
    var remap: [UInt32: UInt32] = [:]
    var triangles: [PlyTriangle] = []

    func compactIndex(_ sourceIndex: UInt32) -> UInt32? {
      if let existing = remap[sourceIndex] {
        return existing
      }
      guard Int(sourceIndex) < sourceVertices.count else { return nil }
      let nextIndex = UInt32(vertices.count)
      vertices.append(sourceVertices[Int(sourceIndex)])
      remap[sourceIndex] = nextIndex
      return nextIndex
    }

    for triangle in sourceTriangles {
      guard
        let a = compactIndex(triangle.a),
        let b = compactIndex(triangle.b),
        let c = compactIndex(triangle.c)
      else {
        continue
      }
      triangles.append(PlyTriangle(a: a, b: b, c: c))
    }
    return PlyMesh(
      vertices: vertices,
      triangles: triangles,
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
    isCapturePaused = false
    captureConfiguration = nil
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
