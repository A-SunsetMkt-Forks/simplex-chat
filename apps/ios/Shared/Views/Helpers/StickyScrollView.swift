//
//  StickyScrollView.swift
//  SimpleX (iOS)
//
//  Created by user on 20/09/2024.
//  Copyright © 2024 SimpleX Chat. All rights reserved.
//

import SwiftUI

struct StickyScrollView<Content: View>: UIViewRepresentable {
    @ViewBuilder let content: () -> Content

    func makeUIView(context: Context) -> UIScrollView {
        let hc = context.coordinator.hostingController
        let scrollView = UIScrollView()
        scrollView.addSubview(hc.view)
        scrollView.delegate = context.coordinator
        hc.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            hc.view.leadingAnchor.constraint(equalTo: scrollView.leadingAnchor),
            hc.view.trailingAnchor.constraint(equalTo: scrollView.trailingAnchor),
            hc.view.topAnchor.constraint(equalTo: scrollView.topAnchor),
            hc.view.bottomAnchor.constraint(equalTo: scrollView.bottomAnchor)
        ])
        return scrollView
    }

    func updateUIView(_ scrollView: UIScrollView, context: Context) {
        context.coordinator.hostingController.rootView = content()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            scrollView.setNeedsUpdateConstraints()
            scrollView.setNeedsLayout()
            scrollView.setNeedsDisplay()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(content: content())
    }

    class Coordinator: NSObject, UIScrollViewDelegate {
        let hostingController: UIHostingController<Content>

        init(content: Content) {
            self.hostingController = UIHostingController(rootView: content)
        }

        func scrollViewWillEndDragging(
            _ scrollView: UIScrollView,
            withVelocity velocity: CGPoint,
            targetContentOffset: UnsafeMutablePointer<CGPoint>
        ) {
            if targetContentOffset.pointee.x < 100 {
                targetContentOffset.pointee.x = 0
            }
        }
    }
}
