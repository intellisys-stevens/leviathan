package collector

import (
	"time"

	"github.com/intellisys-stevens/miglens/internal/history"
)

func historyForTest() *history.Buffer { return history.New(time.Minute, time.Second) }
