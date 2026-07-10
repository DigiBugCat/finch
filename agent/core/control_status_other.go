//go:build !unix

package core

import "fmt"

func readRuntimeServices() ([]ServiceStatus, error) {
	return nil, fmt.Errorf("dynamic control status is unavailable on this platform")
}
