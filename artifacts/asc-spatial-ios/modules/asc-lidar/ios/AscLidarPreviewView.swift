import ARKit
import ExpoModulesCore
import Metal
import SceneKit
import UIKit

public final class AscLidarPreviewView: ExpoView, ARSCNViewDelegate {
  private let maximumPreviewTriangles = 4_000
  private let sceneView = ARSCNView(frame: .zero)
  private var onAnchorsChanged: (([ARAnchor], [UUID]) -> Void)?
  private var lastGeometryUpdate: [UUID: TimeInterval] = [:]

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    backgroundColor = .black
    clipsToBounds = true
    sceneView.scene = SCNScene()
    sceneView.backgroundColor = .black
    sceneView.automaticallyUpdatesLighting = false
    sceneView.delegate = self
    addSubview(sceneView)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    sceneView.frame = bounds
  }

  func connect(
    session: ARSession,
    onAnchorsChanged: @escaping ([ARAnchor], [UUID]) -> Void
  ) {
    self.onAnchorsChanged = onAnchorsChanged
    if sceneView.session !== session {
      sceneView.session = session
    }
    sceneView.delegate = self
  }

  public func renderer(
    _ renderer: SCNSceneRenderer,
    didAdd node: SCNNode,
    for anchor: ARAnchor
  ) {
    guard let meshAnchor = anchor as? ARMeshAnchor else { return }
    onAnchorsChanged?([meshAnchor], [])
    updateCoverageMesh(for: meshAnchor, on: node, force: true)
  }

  public func renderer(
    _ renderer: SCNSceneRenderer,
    didUpdate node: SCNNode,
    for anchor: ARAnchor
  ) {
    guard let meshAnchor = anchor as? ARMeshAnchor else { return }
    onAnchorsChanged?([meshAnchor], [])
    updateCoverageMesh(for: meshAnchor, on: node)
  }

  public func renderer(
    _ renderer: SCNSceneRenderer,
    didRemove node: SCNNode,
    for anchor: ARAnchor
  ) {
    onAnchorsChanged?([], [anchor.identifier])
    lastGeometryUpdate.removeValue(forKey: anchor.identifier)
  }

  private func updateCoverageMesh(
    for anchor: ARMeshAnchor,
    on anchorNode: SCNNode,
    force: Bool = false
  ) {
    let now = ProcessInfo.processInfo.systemUptime
    guard
      force ||
      now - (lastGeometryUpdate[anchor.identifier] ?? 0) >= 0.4
    else {
      return
    }
    lastGeometryUpdate[anchor.identifier] = now

    guard let geometries = makeCoverageGeometries(from: anchor.geometry) else {
      return
    }
    let coverageNode =
      anchorNode.childNode(withName: "asc-spatial-coverage", recursively: false)
      ?? SCNNode()
    coverageNode.name = "asc-spatial-coverage"
    coverageNode.geometry = geometries.surface
    if coverageNode.parent == nil {
      anchorNode.addChildNode(coverageNode)
    }
    let wireframeNode =
      coverageNode.childNode(withName: "asc-spatial-wireframe", recursively: false)
      ?? SCNNode()
    wireframeNode.name = "asc-spatial-wireframe"
    wireframeNode.geometry = geometries.wireframe
    wireframeNode.renderingOrder = 1
    if wireframeNode.parent == nil {
      coverageNode.addChildNode(wireframeNode)
    }
  }

  private func makeCoverageGeometries(
    from mesh: ARMeshGeometry
  ) -> (surface: SCNGeometry, wireframe: SCNGeometry)? {
    let vertices = mesh.vertices
    let faces = mesh.faces
    guard vertices.count > 0, faces.count > 0, faces.indexCountPerPrimitive == 3 else {
      return nil
    }

    let vertexData = Data(
      bytes: vertices.buffer.contents(),
      count: vertices.buffer.length
    )
    let vertexSource = SCNGeometrySource(
      data: vertexData,
      semantic: .vertex,
      vectorCount: vertices.count,
      usesFloatComponents: true,
      componentsPerVector: 3,
      bytesPerComponent: MemoryLayout<Float>.size,
      dataOffset: vertices.offset,
      dataStride: vertices.stride
    )

    let bytesPerPrimitive = faces.indexCountPerPrimitive * faces.bytesPerIndex
    let sampleStep = max(
      1,
      Int(ceil(Double(faces.count) / Double(maximumPreviewTriangles)))
    )
    var faceData = Data()
    faceData.reserveCapacity(
      ((faces.count + sampleStep - 1) / sampleStep) * bytesPerPrimitive
    )
    let faceBuffer = faces.buffer.contents()
    for faceIndex in stride(from: 0, to: faces.count, by: sampleStep) {
      let facePointer = faceBuffer.advanced(by: faceIndex * bytesPerPrimitive)
      faceData.append(Data(bytes: facePointer, count: bytesPerPrimitive))
    }
    let previewFaceCount = faceData.count / bytesPerPrimitive
    let faceElement = SCNGeometryElement(
      data: faceData,
      primitiveType: .triangles,
      primitiveCount: previewFaceCount,
      bytesPerIndex: faces.bytesPerIndex
    )
    let surface = SCNGeometry(sources: [vertexSource], elements: [faceElement])
    let surfaceMaterial = SCNMaterial()
    surfaceMaterial.diffuse.contents =
      UIColor(red: 0.58, green: 1, blue: 0.27, alpha: 0.28)
    surfaceMaterial.emission.contents =
      UIColor(red: 0.18, green: 0.38, blue: 0.05, alpha: 0.18)
    surfaceMaterial.lightingModel = .constant
    surfaceMaterial.transparency = 0.34
    surfaceMaterial.isDoubleSided = true
    surface.materials = [surfaceMaterial]

    let wireframe = SCNGeometry(sources: [vertexSource], elements: [faceElement])
    let wireframeMaterial = SCNMaterial()
    wireframeMaterial.diffuse.contents =
      UIColor(red: 0.58, green: 1, blue: 0.27, alpha: 1)
    wireframeMaterial.emission.contents =
      UIColor(red: 0.25, green: 0.52, blue: 0.08, alpha: 1)
    wireframeMaterial.lightingModel = .constant
    wireframeMaterial.fillMode = .lines
    wireframeMaterial.isDoubleSided = true
    wireframeMaterial.writesToDepthBuffer = false
    wireframe.materials = [wireframeMaterial]
    return (surface, wireframe)
  }
}
