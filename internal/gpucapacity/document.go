// Package gpucapacity reads the optional local GPU-capacity bridge.
package gpucapacity

import "github.com/intellisys-stevens/leviathan/model"

const (
	StaleAfter       = model.GPUCapacityStaleAfter
	MaxDocumentBytes = model.GPUCapacityMaxDocumentBytes
	MaxRows          = model.GPUCapacityMaxRows
)

type Row = model.GPUCapacityRow
type Document = model.GPUCapacityDocument

func Unavailable(message string) Document { return model.UnavailableGPUCapacity(message) }
